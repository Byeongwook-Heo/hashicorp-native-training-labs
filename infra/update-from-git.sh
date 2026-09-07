#!/usr/bin/env bash
set -Eeuo pipefail

umask 0022

readonly APP_ROOT="/opt/vault-lab"
readonly REPOSITORY_DIR="${APP_ROOT}/repository"
readonly RELEASES_DIR="${APP_ROOT}/releases"
readonly CURRENT_LINK="${APP_ROOT}/current"
readonly ENV_FILE="/etc/vault-lab/vault-lab.env"
readonly DEPLOY_LOCK="/run/lock/vault-lab-deploy.lock"
readonly BUILD_USER="vault-lab-build"
readonly BUILD_HOME="/var/lib/vault-lab-build"
readonly NPM_CACHE="/var/cache/vault-lab/npm"
readonly NODE_BIN="/usr/bin/node-22"
readonly NPM_BIN="/usr/bin/npm-22"
readonly WEB_UNIT="/etc/systemd/system/vault-lab-web.service"
readonly SLICE_UNIT="/etc/systemd/system/vault-lab.slice"
readonly CADDY_CONFIG="/etc/caddy/Caddyfile"
readonly NATIVE_ABI_FILE="/etc/vault-lab/native-control-abi"
readonly NATIVE_SMOKE_PENDING_FILE="/etc/vault-lab/native-smoke-pending"
readonly NATIVE_SLOT_COUNT_FILE="/etc/vault-lab/native-slot-count"
readonly SLOT_FILESYSTEM_ENV="/etc/vault-lab/slot-filesystem.env"

: "${DEPLOY_BRANCH:=main}"
: "${DEPLOY_COMMIT:=}"
: "${RELEASE_RETENTION:=5}"
: "${FAILED_RELEASE_RETENTION:=2}"
: "${RUN_NATIVE_SMOKE:=false}"
: "${DEFER_CADDY_START:=false}"

if (( EUID != 0 )); then
  echo "update-from-git.sh는 root로 실행해야 합니다." >&2
  exit 1
fi
if [[ ! "$DEPLOY_BRANCH" =~ ^[A-Za-z0-9._/-]+$ \
  || "$DEPLOY_BRANCH" == -* \
  || "$DEPLOY_BRANCH" == *".."* ]]; then
  echo "DEPLOY_BRANCH 형식이 올바르지 않습니다." >&2
  exit 1
fi
if [[ -n "$DEPLOY_COMMIT" && ! "$DEPLOY_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo "DEPLOY_COMMIT은 40자리 소문자 Git SHA여야 합니다." >&2
  exit 1
fi
if [[ ! "$RELEASE_RETENTION" =~ ^[0-9]+$ ]] \
  || (( 10#$RELEASE_RETENTION < 2 || 10#$RELEASE_RETENTION > 20 )); then
  echo "RELEASE_RETENTION은 2부터 20 사이의 정수여야 합니다." >&2
  exit 1
fi
if [[ ! "$FAILED_RELEASE_RETENTION" =~ ^[0-9]+$ ]] \
  || (( 10#$FAILED_RELEASE_RETENTION > 20 )); then
  echo "FAILED_RELEASE_RETENTION은 0부터 20 사이의 정수여야 합니다." >&2
  exit 1
fi
for boolean_value in "$RUN_NATIVE_SMOKE" "$DEFER_CADDY_START"; do
  if [[ "$boolean_value" != "true" && "$boolean_value" != "false" ]]; then
    echo "RUN_NATIVE_SMOKE와 DEFER_CADDY_START는 true 또는 false여야 합니다." >&2
    exit 1
  fi
done

for command_name in \
  caddy cmp curl dirname find flock git grep jq readlink stat sudo systemctl \
  systemd-analyze sync; do
  command -v "$command_name" >/dev/null || {
    echo "필수 명령이 없습니다: ${command_name}" >&2
    exit 1
  }
done
[[ -x "$NODE_BIN" && -x "$NPM_BIN" ]] || {
  echo "Amazon Linux nodejs22/nodejs22-npm 패키지가 필요합니다." >&2
  exit 1
}
[[ -d "${REPOSITORY_DIR}/.git" ]] || {
  echo "${REPOSITORY_DIR}에 Git checkout이 없습니다." >&2
  exit 1
}
[[ -r "$ENV_FILE" ]] || {
  echo "서비스 환경 파일이 없습니다: ${ENV_FILE}" >&2
  exit 1
}
id "$BUILD_USER" >/dev/null 2>&1 || {
  echo "빌드 전용 사용자가 없습니다: ${BUILD_USER}" >&2
  exit 1
}

install -d -o root -g root -m 0755 "$APP_ROOT" "$RELEASES_DIR"
install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 0700 "$BUILD_HOME" "$NPM_CACHE"
exec 9>"$DEPLOY_LOCK"
if ! flock -n 9; then
  echo "다른 Vault Lab 배포가 진행 중입니다." >&2
  exit 1
fi

native_smoke_pending=false
native_smoke_pending_abi=""
native_smoke_pending_kind=""
native_migration_pending=false
if [[ -e "$NATIVE_SMOKE_PENDING_FILE" || -L "$NATIVE_SMOKE_PENDING_FILE" ]]; then
  # A durable pending gate always wins over availability, including when its
  # metadata is unsafe. Stop boot and the current process before inspecting it.
  systemctl stop vault-lab-web.service >/dev/null 2>&1 || true
  systemctl disable vault-lab-web.service >/dev/null 2>&1 || true
  sync -f /etc/systemd/system
  if systemctl is-active --quiet vault-lab-web.service \
    || systemctl is-enabled --quiet vault-lab-web.service; then
    echo "native smoke pending 상태에서 web을 fail-closed로 전환하지 못했습니다." >&2
    exit 1
  fi
  if [[ ! -f "$NATIVE_SMOKE_PENDING_FILE" \
    || -L "$NATIVE_SMOKE_PENDING_FILE" ]]; then
    echo "native smoke pending marker가 안전한 root 일반 파일이 아닙니다." >&2
    exit 1
  fi
  if [[ "$(stat -c '%u:%g:%a' -- "$NATIVE_SMOKE_PENDING_FILE")" \
    != "0:0:600" ]]; then
    echo "native smoke pending marker가 안전한 root 일반 파일이 아닙니다." >&2
    exit 1
  fi
  native_smoke_pending_value="$(
    tr -d '\n' <"$NATIVE_SMOKE_PENDING_FILE"
  )"
  if [[ ! "$native_smoke_pending_value" \
    =~ ^native-smoke-pending:([1-9][0-9]*):(migration|sync)$ ]]; then
    echo "native smoke pending marker 내용이 올바르지 않습니다." >&2
    exit 1
  fi
  native_smoke_pending=true
  native_smoke_pending_abi="${BASH_REMATCH[1]}"
  native_smoke_pending_kind="${BASH_REMATCH[2]}"
  if [[ "$native_smoke_pending_kind" == "migration" ]]; then
    native_migration_pending=true
  fi
fi

cleanup_failed_releases() {
  local retained=0
  local entry_path
  local entry_name
  local modified_at

  while IFS=' ' read -r modified_at entry_path; do
    [[ -n "$modified_at" && -n "$entry_path" ]] || continue
    [[ "$entry_path" == "${RELEASES_DIR}/"* ]] || {
      echo "실패 release 정리 범위를 벗어난 경로를 거부했습니다: ${entry_path}" >&2
      return 1
    }
    entry_name="${entry_path#"${RELEASES_DIR}/"}"
    if [[ "$entry_name" == */* \
      || ! "$entry_name" =~ ^[a-f0-9]{40}\.failed\.[0-9]{8}T[0-9]{6}Z(\.[0-9]+)?$ \
      || -L "$entry_path" \
      || ! -d "$entry_path" ]]; then
      echo "예상하지 못한 실패 release 경로를 보존합니다: ${entry_path}" >&2
      continue
    fi

    retained=$((retained + 1))
    if (( retained <= 10#$FAILED_RELEASE_RETENTION )); then
      continue
    fi
    if [[ "$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)" == "$entry_path" ]]; then
      echo "활성 release로 확인된 경로는 정리하지 않습니다: ${entry_path}" >&2
      continue
    fi

    if ! find "$entry_path" -xdev -mindepth 1 -delete \
      || ! rmdir -- "$entry_path"; then
      echo "실패 release를 안전하게 정리하지 못했습니다: ${entry_path}" >&2
      return 1
    fi
    echo "보존 한도를 초과한 실패 release를 정리했습니다: ${entry_path}" >&2
  done < <(
    find "$RELEASES_DIR" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -name '*.failed.*' \
      -printf '%T@ %p\n' \
      | sort -nr
  )
}

read_env_value() {
  local key="$1"
  awk -F= -v wanted="$key" '
    $1 == wanted {
      sub(/^[^=]*=/, "", $0)
      print
      exit
    }
  ' "$ENV_FILE"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "/etc/vault-lab/vault-lab.env.XXXXXX")"
  awk -v wanted="$key" -v replacement="$value" '
    BEGIN { found = 0 }
    index($0, wanted "=") == 1 {
      if (found == 0) print wanted "=" replacement
      found = 1
      next
    }
    { print }
    END {
      if (found == 0) print wanted "=" replacement
    }
  ' "$ENV_FILE" >"$temporary"
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -f "$temporary" "$ENV_FILE"
}

LAB_HOST="$(read_env_value LAB_HOST)"
LAB_LEGACY_HOST="$(read_env_value LAB_LEGACY_HOST)"
if [[ -z "$LAB_HOST" || ! "$LAB_HOST" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "환경 파일의 LAB_HOST가 없거나 올바르지 않습니다." >&2
  exit 1
fi
if [[ -n "$LAB_LEGACY_HOST" && ! "$LAB_LEGACY_HOST" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "환경 파일의 LAB_LEGACY_HOST가 올바르지 않습니다." >&2
  exit 1
fi
export LAB_HOST LAB_LEGACY_HOST

git -C "$REPOSITORY_DIR" fetch \
  --prune \
  origin \
  "+refs/heads/${DEPLOY_BRANCH}:refs/remotes/origin/${DEPLOY_BRANCH}"
branch_commit="$(git -C "$REPOSITORY_DIR" rev-parse --verify "origin/${DEPLOY_BRANCH}^{commit}")"
if [[ -n "$DEPLOY_COMMIT" ]]; then
  git -C "$REPOSITORY_DIR" cat-file -e "${DEPLOY_COMMIT}^{commit}"
  if ! git -C "$REPOSITORY_DIR" merge-base --is-ancestor \
    "$DEPLOY_COMMIT" "$branch_commit"; then
    echo "DEPLOY_COMMIT이 origin/${DEPLOY_BRANCH} 이력에 없습니다." >&2
    exit 1
  fi
  target_commit="$DEPLOY_COMMIT"
else
  target_commit="$branch_commit"
fi

readonly target_commit
readonly release_dir="${RELEASES_DIR}/${target_commit}"
readonly release_marker="${release_dir}/.vault-lab-release-ready"
release_is_ready=false
if [[ -r "$release_marker" ]] \
  && [[ "$(tr -d '\n' <"$release_marker")" == "$target_commit" ]] \
  && [[ -r "${release_dir}/dist-server/index.js" ]] \
  && [[ -r "${release_dir}/dist/index.html" ]]; then
  release_is_ready=true
fi

if [[ "$release_is_ready" == "false" ]]; then
  if [[ -e "$release_dir" ]]; then
    failed_release="${release_dir}.failed.$(date -u +%Y%m%dT%H%M%SZ).$$"
    mv -- "$release_dir" "$failed_release"
    git -C "$REPOSITORY_DIR" worktree prune
    echo "완료되지 않은 기존 release를 보존했습니다: ${failed_release}" >&2
  fi
  cleanup_failed_releases

  git -C "$REPOSITORY_DIR" worktree add --detach "$release_dir" "$target_commit"
  chown -R "${BUILD_USER}:${BUILD_USER}" "$release_dir"

  (
    cd "$release_dir"
    sudo -u "$BUILD_USER" \
      env HOME="$BUILD_HOME" npm_config_cache="$NPM_CACHE" \
      "$NPM_BIN" ci --no-audit --no-fund
    sudo -u "$BUILD_USER" \
      env HOME="$BUILD_HOME" npm_config_cache="$NPM_CACHE" \
      "$NPM_BIN" test -- --maxWorkers=1
    sudo -u "$BUILD_USER" \
      env HOME="$BUILD_HOME" npm_config_cache="$NPM_CACHE" \
      "$NPM_BIN" run build
    sudo -u "$BUILD_USER" \
      env HOME="$BUILD_HOME" npm_config_cache="$NPM_CACHE" \
      "$NPM_BIN" prune --omit=dev --no-audit --no-fund
  )

  "$NODE_BIN" --check "${release_dir}/dist-server/index.js"
  chown -R root:root "$release_dir"
  chmod -R a+rX,go-w "$release_dir"
  sudo -u vault-lab test -r "${release_dir}/dist-server/index.js"
  sudo -u vault-lab test -r "${release_dir}/dist/index.html"
  printf '%s\n' "$target_commit" >"$release_marker"
  chmod 0444 "$release_marker"
fi

readonly -a NATIVE_RELEASE_PATHS=(
  "infra/native/vault-lab-control"
  "infra/native/vault-lab-shell"
  "infra/native/vault-lab-exec"
  "infra/native/vault-lab-loopback"
  "infra/native/vault-lab-reaper"
  "infra/native/vault-lab@.service"
  "infra/native/vault-lab-loopback.service"
  "infra/native/vault-lab-reaper.service"
  "infra/native/vault-lab-reaper.timer"
  "infra/native/CONTROL_ABI"
)
readonly -a NATIVE_INSTALLED_PATHS=(
  "/usr/local/sbin/vault-lab-control"
  "/usr/local/libexec/vault-lab-shell"
  "/usr/local/libexec/vault-lab-exec"
  "/usr/local/sbin/vault-lab-loopback"
  "/usr/local/sbin/vault-lab-reaper"
  "/etc/systemd/system/vault-lab@.service"
  "/etc/systemd/system/vault-lab-loopback.service"
  "/etc/systemd/system/vault-lab-reaper.service"
  "/etc/systemd/system/vault-lab-reaper.timer"
  "$NATIVE_ABI_FILE"
)
readonly -a NATIVE_INSTALLED_MODES=(
  "755"
  "755"
  "755"
  "755"
  "755"
  "644"
  "644"
  "644"
  "644"
  "644"
)
declare -a native_artifact_was_present=()
native_backup_root=""

for native_release_path in "${NATIVE_RELEASE_PATHS[@]}"; do
  native_source="${release_dir}/${native_release_path}"
  [[ -f "$native_source" && ! -L "$native_source" ]] || {
    echo "native release asset이 없거나 안전하지 않습니다: ${native_source}" >&2
    exit 1
  }
done
release_native_control_abi="$(
  tr -d '\n' <"${release_dir}/infra/native/CONTROL_ABI"
)"
if [[ ! "$release_native_control_abi" =~ ^[1-9][0-9]*$ ]] \
  || ! grep -Fqx \
    "const NATIVE_CONTROL_ABI = \"${release_native_control_abi}\";" \
    "${release_dir}/server/native-runtime.ts" \
  || ! grep -Fq \
    "const NATIVE_CONTROL_ABI = \"${release_native_control_abi}\";" \
    "${release_dir}/dist-server/native-runtime.js"; then
  echo "release의 native control ABI와 애플리케이션 ABI가 일치하지 않습니다." >&2
  exit 1
fi
readonly release_native_control_abi
for native_script in \
  vault-lab-control \
  vault-lab-shell \
  vault-lab-exec \
  vault-lab-loopback \
  vault-lab-reaper; do
  bash -n "${release_dir}/infra/native/${native_script}"
done

backup_native_artifacts() {
  local artifact_index
  local target_path
  local backup_path

  native_backup_root="${backup_dir}/native-installed"
  install -d -o root -g root -m 0700 "$native_backup_root"
  for artifact_index in "${!NATIVE_INSTALLED_PATHS[@]}"; do
    target_path="${NATIVE_INSTALLED_PATHS[$artifact_index]}"
    backup_path="${native_backup_root}${target_path}"
    install -d -o root -g root -m 0700 "$(dirname -- "$backup_path")"
    if [[ -e "$target_path" || -L "$target_path" ]]; then
      [[ -f "$target_path" && ! -L "$target_path" ]] || {
        echo "설치된 native artifact가 안전한 일반 파일이 아닙니다: ${target_path}" >&2
        return 1
      }
      cp -a -- "$target_path" "$backup_path"
      native_artifact_was_present[artifact_index]=true
    else
      native_artifact_was_present[artifact_index]=false
    fi
  done
  sync
}

verify_installed_native_artifacts() {
  local include_abi="${1:-true}"
  local artifact_index
  local source_path
  local target_path
  local expected_mode

  for artifact_index in "${!NATIVE_INSTALLED_PATHS[@]}"; do
    source_path="${release_dir}/${NATIVE_RELEASE_PATHS[$artifact_index]}"
    target_path="${NATIVE_INSTALLED_PATHS[$artifact_index]}"
    expected_mode="${NATIVE_INSTALLED_MODES[$artifact_index]}"
    if [[ "$include_abi" == "false" && "$target_path" == "$NATIVE_ABI_FILE" ]]; then
      continue
    fi
    [[ -f "$target_path" && ! -L "$target_path" ]] || return 1
    cmp -s -- "$source_path" "$target_path" || return 1
    [[ "$(stat -c '%u:%g:%a' -- "$target_path")" \
      == "0:0:${expected_mode}" ]] || return 1
  done
}

sync_native_artifacts() {
  local artifact_index
  local source_path
  local target_path
  local expected_mode
  local temporary_path

  for artifact_index in "${!NATIVE_INSTALLED_PATHS[@]}"; do
    source_path="${release_dir}/${NATIVE_RELEASE_PATHS[$artifact_index]}"
    target_path="${NATIVE_INSTALLED_PATHS[$artifact_index]}"
    expected_mode="${NATIVE_INSTALLED_MODES[$artifact_index]}"
    [[ "$target_path" != "$NATIVE_ABI_FILE" ]] || continue
    temporary_path="${target_path}.vault-lab-update.$$"
    rm -f -- "$temporary_path"
    if ! install \
      -o root \
      -g root \
      -m "0${expected_mode}" \
      "$source_path" \
      "$temporary_path"; then
      rm -f -- "$temporary_path"
      return 1
    fi
    if ! mv -fT -- "$temporary_path" "$target_path"; then
      rm -f -- "$temporary_path"
      return 1
    fi
    sync -f "$target_path"
  done
  restorecon -RF \
    /usr/local/sbin/vault-lab-control \
    /usr/local/sbin/vault-lab-reaper \
    /usr/local/sbin/vault-lab-loopback \
    /usr/local/libexec/vault-lab-shell \
    /usr/local/libexec/vault-lab-exec 2>/dev/null || true
  verify_installed_native_artifacts false
}

assert_native_smoke_pending() {
  local pending_value

  [[ -f "$NATIVE_SMOKE_PENDING_FILE" \
    && ! -L "$NATIVE_SMOKE_PENDING_FILE" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' -- "$NATIVE_SMOKE_PENDING_FILE")" \
    == "0:0:600" ]] || return 1
  pending_value="$(tr -d '\n' <"$NATIVE_SMOKE_PENDING_FILE")"
  [[ "$pending_value" \
    =~ ^native-smoke-pending:([1-9][0-9]*):(migration|sync)$ ]] \
    || return 1
  [[ "${BASH_REMATCH[1]}" == "$release_native_control_abi" ]]
}

write_native_smoke_pending() {
  local pending_kind="$1"
  local temporary_path="${NATIVE_SMOKE_PENDING_FILE}.vault-lab-update.$$"

  [[ "$pending_kind" == "migration" || "$pending_kind" == "sync" ]] \
    || return 1
  rm -f -- "$temporary_path"
  printf 'native-smoke-pending:%s:%s\n' \
    "$release_native_control_abi" \
    "$pending_kind" \
    >"$temporary_path"
  chown root:root "$temporary_path"
  chmod 0600 "$temporary_path"
  sync -f "$temporary_path"
  mv -fT -- "$temporary_path" "$NATIVE_SMOKE_PENDING_FILE"
  sync -f "$NATIVE_SMOKE_PENDING_FILE"
  sync -f "$(dirname -- "$NATIVE_SMOKE_PENDING_FILE")"
  assert_native_smoke_pending
  [[ "$(<"$NATIVE_SMOKE_PENDING_FILE")" \
    == "native-smoke-pending:${release_native_control_abi}:${pending_kind}" ]]
  native_smoke_pending=true
  native_smoke_pending_abi="$release_native_control_abi"
  native_smoke_pending_kind="$pending_kind"
  if [[ "$pending_kind" == "migration" ]]; then
    native_migration_pending=true
  fi
}

clear_native_smoke_pending() {
  assert_native_smoke_pending || {
    echo "검증되지 않은 native smoke pending marker는 제거하지 않습니다." >&2
    return 1
  }
  rm -f -- "$NATIVE_SMOKE_PENDING_FILE"
  sync -f "$(dirname -- "$NATIVE_SMOKE_PENDING_FILE")"
  if [[ -e "$NATIVE_SMOKE_PENDING_FILE" \
    || -L "$NATIVE_SMOKE_PENDING_FILE" ]]; then
    echo "native smoke pending marker 제거를 확정하지 못했습니다." >&2
    return 1
  fi
  native_smoke_pending=false
  native_smoke_pending_abi=""
  native_smoke_pending_kind=""
}

write_native_abi_sentinel() {
  local temporary_path="${NATIVE_ABI_FILE}.vault-lab-update.$$"

  rm -f -- "$temporary_path"
  printf 'updating-%s\n' "$release_native_control_abi" >"$temporary_path"
  chown root:root "$temporary_path"
  chmod 0644 "$temporary_path"
  sync -f "$temporary_path"
  mv -fT -- "$temporary_path" "$NATIVE_ABI_FILE"
  sync -f "$NATIVE_ABI_FILE"
  sync -f "$(dirname -- "$NATIVE_ABI_FILE")"
  [[ "$(<"$NATIVE_ABI_FILE")" == "updating-${release_native_control_abi}" \
    && "$(stat -c '%u:%g:%a' -- "$NATIVE_ABI_FILE")" == "0:0:644" ]]
}

commit_native_abi() {
  local source_path="${release_dir}/infra/native/CONTROL_ABI"
  local temporary_path="${NATIVE_ABI_FILE}.vault-lab-commit.$$"

  rm -f -- "$temporary_path"
  if ! install \
    -o root \
    -g root \
    -m 0644 \
    "$source_path" \
    "$temporary_path"; then
    rm -f -- "$temporary_path"
    return 1
  fi
  sync -f "$temporary_path"
  if ! mv -fT -- "$temporary_path" "$NATIVE_ABI_FILE"; then
    rm -f -- "$temporary_path"
    return 1
  fi
  sync -f "$NATIVE_ABI_FILE"
  sync -f "$(dirname -- "$NATIVE_ABI_FILE")"
  verify_installed_native_artifacts
}

restore_native_artifacts() {
  local artifact_index
  local target_path
  local backup_path
  local temporary_path
  local restore_complete=true

  for artifact_index in "${!NATIVE_INSTALLED_PATHS[@]}"; do
    target_path="${NATIVE_INSTALLED_PATHS[$artifact_index]}"
    backup_path="${native_backup_root}${target_path}"
    if [[ "${native_artifact_was_present[$artifact_index]:-false}" == "true" ]]; then
      if [[ ! -f "$backup_path" || -L "$backup_path" ]]; then
        restore_complete=false
        continue
      fi
      temporary_path="${target_path}.vault-lab-rollback.$$"
      rm -f -- "$temporary_path"
      if ! cp -a -- "$backup_path" "$temporary_path" \
        || ! mv -fT -- "$temporary_path" "$target_path" \
        || ! cmp -s -- "$backup_path" "$target_path" \
        || [[ "$(stat -c '%u:%g:%a' -- "$backup_path")" \
          != "$(stat -c '%u:%g:%a' -- "$target_path")" ]]; then
        rm -f -- "$temporary_path"
        restore_complete=false
      fi
    elif ! rm -f -- "$target_path"; then
      restore_complete=false
    fi
  done
  sync
  [[ "$restore_complete" == "true" ]]
}

installed_native_abi=""
if [[ -e "$NATIVE_ABI_FILE" || -L "$NATIVE_ABI_FILE" ]]; then
  [[ -f "$NATIVE_ABI_FILE" && ! -L "$NATIVE_ABI_FILE" ]] || {
    echo "설치된 native ABI marker가 안전한 일반 파일이 아닙니다." >&2
    exit 1
  }
  installed_native_abi="$(tr -d '\n' <"$NATIVE_ABI_FILE")"
fi
native_migration_required=false
if [[ "$installed_native_abi" != "$release_native_control_abi" ]]; then
  native_migration_required=true
fi
native_runtime_needs_sync="$native_migration_required"
native_previous_runtime_complete=true
for artifact_index in "${!NATIVE_INSTALLED_PATHS[@]}"; do
  target_path="${NATIVE_INSTALLED_PATHS[$artifact_index]}"
  source_path="${release_dir}/${NATIVE_RELEASE_PATHS[$artifact_index]}"
  expected_mode="${NATIVE_INSTALLED_MODES[$artifact_index]}"
  if [[ -L "$target_path" \
    || ( -e "$target_path" && ! -f "$target_path" ) ]]; then
    echo "설치된 native artifact가 안전한 일반 파일이 아닙니다: ${target_path}" >&2
    exit 1
  fi
  if [[ ! -f "$target_path" ]]; then
    native_runtime_needs_sync=true
    native_previous_runtime_complete=false
    continue
  fi
  if ! cmp -s -- "$source_path" "$target_path" \
    || [[ "$(stat -c '%u:%g:%a' -- "$target_path")" \
      != "0:0:${expected_mode}" ]]; then
    native_runtime_needs_sync=true
  fi
  if [[ "$(stat -c '%u:%g:%a' -- "$target_path")" \
    != "0:0:${expected_mode}" ]]; then
    native_previous_runtime_complete=false
  fi
done

# A pending gate from an interrupted deployment can target a different ABI
# than this retry. Re-stage the complete target payload before smoke so the
# gate can only be cleared for the ABI that the new web release consumes.
if [[ "$native_smoke_pending" == "true" \
  && "$native_smoke_pending_abi" != "$release_native_control_abi" ]]; then
  echo "native smoke pending ABI ${native_smoke_pending_abi}를 배포 대상 ABI ${release_native_control_abi}로 재동기화합니다." >&2
  native_runtime_needs_sync=true
fi

native_smoke_required="$RUN_NATIVE_SMOKE"
if [[ "$native_smoke_pending" == "true" \
  || "$native_runtime_needs_sync" == "true" \
  || "$native_migration_required" == "true" ]]; then
  native_smoke_required=true
fi
native_smoke_pending_write_kind="sync"
if [[ "$native_migration_required" == "true" \
  || "$native_migration_pending" == "true" ]]; then
  native_smoke_pending_write_kind="migration"
fi

native_slot_count=""
slot_filesystem_mib="512"
slot_filesystem_inodes="4096"
if [[ "$native_migration_required" == "true" ]]; then
  if [[ -e "$NATIVE_SLOT_COUNT_FILE" || -L "$NATIVE_SLOT_COUNT_FILE" ]]; then
    [[ -f "$NATIVE_SLOT_COUNT_FILE" && ! -L "$NATIVE_SLOT_COUNT_FILE" ]] || {
      echo "설치된 native slot count 파일이 안전하지 않습니다." >&2
      exit 1
    }
    native_slot_count="$(tr -d '\n' <"$NATIVE_SLOT_COUNT_FILE")"
  else
    native_slot_count="$(read_env_value MAX_SESSIONS)"
  fi
  if [[ ! "$native_slot_count" =~ ^[0-9]+$ ]] \
    || (( 10#$native_slot_count < 1 || 10#$native_slot_count > 99 )); then
    echo "ABI migration에 사용할 native slot count가 올바르지 않습니다." >&2
    exit 1
  fi

  if [[ -e "$SLOT_FILESYSTEM_ENV" || -L "$SLOT_FILESYSTEM_ENV" ]]; then
    [[ -f "$SLOT_FILESYSTEM_ENV" && ! -L "$SLOT_FILESYSTEM_ENV" ]] || {
      echo "설치된 slot filesystem 설정 파일이 안전하지 않습니다." >&2
      exit 1
    }
    slot_image_bytes="$(
      awk -F= '$1 == "SLOT_IMAGE_BYTES" { print $2; exit }' \
        "$SLOT_FILESYSTEM_ENV"
    )"
    slot_filesystem_inodes="$(
      awk -F= '$1 == "SLOT_FILESYSTEM_INODES" { print $2; exit }' \
        "$SLOT_FILESYSTEM_ENV"
    )"
    if [[ ! "$slot_image_bytes" =~ ^[0-9]+$ ]] \
      || (( 10#$slot_image_bytes % 1048576 != 0 )); then
      echo "설치된 slot image 크기 설정이 올바르지 않습니다." >&2
      exit 1
    fi
    slot_filesystem_mib="$((10#$slot_image_bytes / 1048576))"
  fi
  if [[ ! "$slot_filesystem_mib" =~ ^[0-9]+$ ]] \
    || (( 10#$slot_filesystem_mib < 256 \
      || 10#$slot_filesystem_mib > 2048 )) \
    || [[ ! "$slot_filesystem_inodes" =~ ^[0-9]+$ ]] \
    || (( 10#$slot_filesystem_inodes < 2048 \
      || 10#$slot_filesystem_inodes > 65536 )); then
    echo "ABI migration에 사용할 slot filesystem 경계가 올바르지 않습니다." >&2
    exit 1
  fi
fi

systemd-analyze verify \
  "${release_dir}/infra/systemd/vault-lab.slice" \
  "${release_dir}/infra/systemd/vault-lab-web.service" \
  "${release_dir}/infra/native/vault-lab@.service" \
  "${release_dir}/infra/native/vault-lab-loopback.service" \
  "${release_dir}/infra/native/vault-lab-reaper.service" \
  "${release_dir}/infra/native/vault-lab-reaper.timer"
caddy validate --config "${release_dir}/Caddyfile" --adapter caddyfile

previous_release="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
web_was_active=false
if systemctl is-active --quiet vault-lab-web.service; then
  web_was_active=true
fi
web_was_enabled=false
if systemctl is-enabled --quiet vault-lab-web.service; then
  web_was_enabled=true
fi
caddy_was_active=false
if systemctl is-active --quiet caddy.service; then
  caddy_was_active=true
fi
caddy_was_enabled=false
if systemctl is-enabled --quiet caddy.service; then
  caddy_was_enabled=true
fi
loopback_was_active=false
if systemctl is-active --quiet vault-lab-loopback.service; then
  loopback_was_active=true
fi
loopback_was_enabled=false
if systemctl is-enabled --quiet vault-lab-loopback.service; then
  loopback_was_enabled=true
fi
reaper_timer_was_active=false
if systemctl is-active --quiet vault-lab-reaper.timer; then
  reaper_timer_was_active=true
fi
reaper_timer_was_enabled=false
if systemctl is-enabled --quiet vault-lab-reaper.timer; then
  reaper_timer_was_enabled=true
fi

backup_dir="$(mktemp -d "/var/lib/vault-lab/deploy-backup.XXXXXX")"
had_web_unit=false
had_slice_unit=false
had_caddy_config=false
if [[ -f "$WEB_UNIT" ]]; then
  cp -a "$WEB_UNIT" "${backup_dir}/vault-lab-web.service"
  had_web_unit=true
fi
if [[ -f "$SLICE_UNIT" ]]; then
  cp -a "$SLICE_UNIT" "${backup_dir}/vault-lab.slice"
  had_slice_unit=true
fi
if [[ -f "$CADDY_CONFIG" ]]; then
  cp -a "$CADDY_CONFIG" "${backup_dir}/Caddyfile"
  had_caddy_config=true
fi
cp -a "$ENV_FILE" "${backup_dir}/vault-lab.env"
if [[ "$native_runtime_needs_sync" == "true" ]]; then
  backup_native_artifacts
fi

activated=false
native_sync_started=false
native_migration_started="$native_migration_pending"

restore_previous_native_service_state() {
  local service_state_complete=true

  if [[ "$loopback_was_enabled" == "true" ]]; then
    systemctl enable vault-lab-loopback.service >/dev/null \
      || service_state_complete=false
  else
    systemctl disable vault-lab-loopback.service >/dev/null \
      || service_state_complete=false
  fi
  if [[ "$loopback_was_active" == "true" ]]; then
    systemctl restart vault-lab-loopback.service \
      || service_state_complete=false
  else
    systemctl stop vault-lab-loopback.service \
      || service_state_complete=false
  fi
  if [[ "$reaper_timer_was_enabled" == "true" ]]; then
    systemctl enable vault-lab-reaper.timer >/dev/null \
      || service_state_complete=false
  else
    systemctl disable vault-lab-reaper.timer >/dev/null \
      || service_state_complete=false
  fi
  if [[ "$reaper_timer_was_active" == "true" ]]; then
    systemctl restart vault-lab-reaper.timer \
      || service_state_complete=false
  else
    systemctl stop vault-lab-reaper.timer \
      || service_state_complete=false
  fi
  sync -f /etc/systemd/system || service_state_complete=false
  [[ "$service_state_complete" == "true" ]]
}

rollback() {
  local status=$?
  local rollback_complete=true
  local native_rollback_succeeded=true
  local native_smoke_gate_present=false
  local web_rollback_safe=false
  trap - ERR
  set +e
  echo "배포 실패. 이전 release와 서비스 구성을 복구합니다." >&2

  if [[ "$activated" == "true" ]]; then
    if [[ "$native_migration_started" == "true" ]]; then
      echo "smoke를 통과한 ABI migration release를 fail-closed current로 유지합니다." >&2
    else
      temporary_link="${APP_ROOT}/.current.rollback.$$"
      rm -f -- "$temporary_link"
      if [[ -n "$previous_release" ]]; then
        if ! ln -s "$previous_release" "$temporary_link" \
          || ! mv -Tf "$temporary_link" "$CURRENT_LINK"; then
          rollback_complete=false
        fi
      elif ! rm -f "$CURRENT_LINK"; then
        rollback_complete=false
      fi
    fi
  fi

  if [[ "$had_web_unit" == "true" ]]; then
    cp -a "${backup_dir}/vault-lab-web.service" "$WEB_UNIT" \
      || rollback_complete=false
  elif ! rm -f "$WEB_UNIT"; then
    rollback_complete=false
  fi
  if [[ "$had_slice_unit" == "true" ]]; then
    cp -a "${backup_dir}/vault-lab.slice" "$SLICE_UNIT" \
      || rollback_complete=false
  elif ! rm -f "$SLICE_UNIT"; then
    rollback_complete=false
  fi
  if [[ "$had_caddy_config" == "true" ]]; then
    cp -a "${backup_dir}/Caddyfile" "$CADDY_CONFIG" \
      || rollback_complete=false
  elif ! rm -f "$CADDY_CONFIG"; then
    rollback_complete=false
  fi
  cp -a "${backup_dir}/vault-lab.env" "$ENV_FILE" \
    || rollback_complete=false

  if [[ "$native_migration_started" == "true" ]]; then
    native_rollback_succeeded=false
    echo "native ABI migration이 시작되어 이전 web과의 호환성을 보장할 수 없습니다." >&2
  elif [[ "$native_sync_started" == "true" ]] \
    && ! restore_native_artifacts; then
    native_rollback_succeeded=false
    echo "설치된 native artifact의 exact rollback에 실패했습니다." >&2
  fi

  sync || rollback_complete=false
  if ! systemctl daemon-reload; then
    rollback_complete=false
    native_rollback_succeeded=false
  fi
  if [[ "$native_sync_started" == "true" \
    && "$native_migration_started" == "false" \
    && "$native_rollback_succeeded" == "true" ]] \
    && ! restore_previous_native_service_state; then
    native_rollback_succeeded=false
  fi

  if [[ -e "$NATIVE_SMOKE_PENDING_FILE" \
    || -L "$NATIVE_SMOKE_PENDING_FILE" ]]; then
    native_smoke_gate_present=true
  fi
  if [[ "$rollback_complete" == "true" \
    && "$native_rollback_succeeded" == "true" \
    && "$native_previous_runtime_complete" == "true" \
    && "$native_smoke_gate_present" == "false" ]]; then
    web_rollback_safe=true
  fi
  if [[ "$web_rollback_safe" == "true" ]]; then
    if [[ "$web_was_enabled" == "true" ]]; then
      systemctl enable vault-lab-web.service >/dev/null \
        || rollback_complete=false
    else
      systemctl disable vault-lab-web.service >/dev/null \
        || rollback_complete=false
    fi
  else
    systemctl disable vault-lab-web.service >/dev/null \
      || rollback_complete=false
  fi
  sync -f /etc/systemd/system || rollback_complete=false
  if [[ "$caddy_was_enabled" == "true" ]]; then
    systemctl enable caddy.service >/dev/null \
      || rollback_complete=false
  else
    systemctl disable caddy.service >/dev/null \
      || rollback_complete=false
  fi

  if [[ "$web_was_active" == "true" \
    && -n "$previous_release" \
    && "$rollback_complete" == "true" \
    && "$web_rollback_safe" == "true" ]]; then
    if ! systemctl restart vault-lab-web.service; then
      rollback_complete=false
      systemctl stop vault-lab-web.service
    fi
  else
    systemctl stop vault-lab-web.service
    if [[ "$web_rollback_safe" != "true" ]]; then
      systemctl disable vault-lab-web.service >/dev/null
    fi
    if [[ "$web_was_active" == "true" ]]; then
      echo "이전 web은 안전한 rollback을 확정하지 못해 fail-closed 상태로 유지합니다." >&2
    fi
  fi
  if [[ "$DEFER_CADDY_START" == "false" ]]; then
    if [[ "$caddy_was_active" == "true" ]]; then
      systemctl restart caddy.service || rollback_complete=false
    else
      systemctl stop caddy.service || rollback_complete=false
    fi
  fi

  if [[ "$rollback_complete" == "true" \
    && "$native_rollback_succeeded" == "true" ]]; then
    find "$backup_dir" -mindepth 1 -delete
    rmdir "$backup_dir"
  else
    echo "수동 복구용 배포 backup을 보존했습니다: ${backup_dir}" >&2
  fi
  exit "$status"
}
trap rollback ERR

stop_native_transient_units() {
  local transient_unit

  while IFS= read -r transient_unit; do
    [[ "$transient_unit" \
      =~ ^vault-lab-(terminal|exec)-s[0-9]{2}-[a-f0-9]{12}\.service$ ]] \
      || continue
    systemctl stop "$transient_unit"
  done < <(
    systemctl list-units \
      --all \
      --full \
      --plain \
      --no-legend \
      'vault-lab-terminal-*.service' \
      'vault-lab-exec-*.service' \
      | awk '{ print $1 }'
  )
}

stop_native_slot_services() {
  local slot_unit

  while IFS= read -r slot_unit; do
    [[ "$slot_unit" =~ ^vault-lab@s[0-9]{2}\.service$ ]] || continue
    systemctl stop "$slot_unit"
  done < <(
    systemctl list-units \
      --all \
      --full \
      --plain \
      --no-legend \
      'vault-lab@*.service' \
      | awk '{ print $1 }'
  )
}

assert_native_consumers_quiesced() {
  local unit_name

  for unit_name in \
    vault-lab-web.service \
    vault-lab-reaper.timer \
    vault-lab-reaper.service \
    vault-lab-loopback.service; do
    if systemctl is-active --quiet "$unit_name"; then
      echo "native payload 교체 전에 ${unit_name}을 중지하지 못했습니다." >&2
      return 1
    fi
  done
  for unit_name in \
    vault-lab-web.service \
    vault-lab-reaper.timer \
    vault-lab-loopback.service; do
    if systemctl is-enabled --quiet "$unit_name"; then
      echo "native payload 교체 전에 ${unit_name}의 boot 시작을 해제하지 못했습니다." >&2
      return 1
    fi
  done
}

if [[ "$native_smoke_required" == "true" ]]; then
  echo "native runtime 갱신을 위해 web 요청을 정상 종료합니다." >&2
  systemctl stop vault-lab-web.service
  systemctl disable vault-lab-web.service
  stop_native_transient_units
  stop_native_slot_services
  sync -f /etc/systemd/system
fi

if [[ "$native_runtime_needs_sync" == "true" ]]; then
  systemctl stop vault-lab-reaper.timer
  systemctl stop vault-lab-reaper.service
  systemctl disable vault-lab-reaper.timer
  systemctl stop vault-lab-loopback.service
  systemctl disable vault-lab-loopback.service
  sync -f /etc/systemd/system
  assert_native_consumers_quiesced
  native_sync_started=true
  write_native_smoke_pending "$native_smoke_pending_write_kind"
  write_native_abi_sentinel

  if [[ "$native_migration_required" == "true" ]]; then
    native_migration_started=true
    echo "native control ABI ${installed_native_abi:-none} -> ${release_native_control_abi} migration을 시작합니다." >&2
    NATIVE_SLOT_COUNT="$native_slot_count" \
    VAULT_VERSION="2.0.3" \
    SLOT_FILESYSTEM_MIB="$slot_filesystem_mib" \
    SLOT_FILESYSTEM_INODES="$slot_filesystem_inodes" \
      "${release_dir}/infra/native-install.sh"
    verify_installed_native_artifacts
  else
    sync_native_artifacts
    systemctl daemon-reload
    systemd-analyze verify \
      /etc/systemd/system/vault-lab@.service \
      /etc/systemd/system/vault-lab-loopback.service \
      /etc/systemd/system/vault-lab-reaper.service \
      /etc/systemd/system/vault-lab-reaper.timer
    systemctl enable vault-lab-loopback.service
    systemctl restart vault-lab-loopback.service
    systemctl enable --now vault-lab-reaper.timer
    systemctl is-active --quiet vault-lab-loopback.service
    systemctl is-active --quiet vault-lab-reaper.timer
    commit_native_abi
  fi
fi

"${release_dir}/infra/install-systemd-units.sh" "$release_dir"
native_smoke_passed=false
if [[ "$native_smoke_required" == "true" ]]; then
  if [[ "$native_smoke_pending" == "true" ]]; then
    assert_native_smoke_pending || {
      echo "native smoke pending gate를 확인하지 못했습니다." >&2
      false
    }
  fi
  "${release_dir}/infra/smoke-native-runtime.sh" "$release_dir"
  native_smoke_passed=true
fi

install -o root -g root -m 0644 "${release_dir}/Caddyfile" "$CADDY_CONFIG"
set_env_value APP_COMMIT_SHA "$target_commit"

temporary_link="${APP_ROOT}/.current.$$"
rm -f "$temporary_link"
ln -s "$release_dir" "$temporary_link"
mv -Tf "$temporary_link" "$CURRENT_LINK"
sync -f "$APP_ROOT"
activated=true

if [[ "$native_smoke_pending" == "true" ]]; then
  [[ "$native_smoke_passed" == "true" ]] || {
    echo "native smoke 성공 없이 pending gate를 제거할 수 없습니다." >&2
    false
  }
  clear_native_smoke_pending
fi

systemctl daemon-reload
systemctl enable vault-lab-web.service
sync -f /etc/systemd/system
systemctl restart vault-lab-web.service
PUBLIC_SMOKE=false EXPECTED_COMMIT="$target_commit" \
  "${release_dir}/infra/smoke-deployment.sh"

if [[ "$DEFER_CADDY_START" == "false" ]]; then
  systemctl enable caddy.service
  systemctl restart caddy.service
  PUBLIC_SMOKE=true LAB_HOST="$LAB_HOST" EXPECTED_COMMIT="$target_commit" \
    "${release_dir}/infra/smoke-deployment.sh"
fi

trap - ERR
find "$backup_dir" -mindepth 1 -delete
rmdir "$backup_dir"

mapfile -t release_paths < <(
  find "$RELEASES_DIR" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -name '[a-f0-9]*' \
    -printf '%T@ %p\n' \
    | sort -nr \
    | awk '{ print $2 }'
)
kept_releases=0
for old_release in "${release_paths[@]}"; do
  [[ -r "${old_release}/.vault-lab-release-ready" ]] || continue
  kept_releases=$((kept_releases + 1))
  if (( kept_releases <= 10#$RELEASE_RETENTION )); then
    continue
  fi
  if [[ "$old_release" == "$release_dir" || "$old_release" == "$previous_release" ]]; then
    continue
  fi
  git -C "$REPOSITORY_DIR" worktree remove --force "$old_release" \
    || echo "오래된 release 정리를 건너뜁니다: ${old_release}" >&2
done
git -C "$REPOSITORY_DIR" worktree prune
cleanup_failed_releases \
  || echo "주의: 배포는 완료됐지만 실패 release 보존 한도 정리를 마치지 못했습니다." >&2

echo "배포 완료: ${target_commit}"
echo "활성 release: ${CURRENT_LINK} -> ${release_dir}"
if [[ "$DEFER_CADDY_START" == "true" ]]; then
  echo "Caddy 전환은 보류되었습니다. infra/cutover-caddy.sh를 실행하세요."
fi
