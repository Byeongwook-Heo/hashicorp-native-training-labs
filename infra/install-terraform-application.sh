#!/usr/bin/env bash
set -Eeuo pipefail

umask 0022

readonly APP_ROOT="/opt/terraform-lab"
readonly REPOSITORY_DIR="${APP_ROOT}/repository"
readonly RELEASES_DIR="${APP_ROOT}/releases"
readonly CURRENT_LINK="${APP_ROOT}/current"
readonly ENV_DIR="/etc/terraform-lab"
readonly ENV_FILE="${ENV_DIR}/terraform-lab.env"
readonly DATA_DIR="/var/lib/terraform-lab/app"
readonly CONTENT_DIR="/var/lib/terraform-lab/content"
readonly BUILD_USER="terraform-lab-build"
readonly BUILD_HOME="/var/lib/terraform-lab-build"
readonly NPM_CACHE="/var/cache/terraform-lab/npm"
readonly INITIAL_CREDENTIAL_FILE="/root/terraform-lab-initial-admin.txt"
readonly NODE_BIN="/usr/bin/node-22"
readonly NPM_BIN="/usr/bin/npm-22"

: "${LAB_HOST:?LAB_HOST가 필요합니다.}"
LAB_LEGACY_HOST="${LAB_LEGACY_HOST-}"
: "${NATIVE_SLOT_COUNT:=4}"
: "${TERRAFORM_VERSION:=1.15.8}"
: "${LAB_ADMIN_EMAIL:=admin@terraform-lab.local}"
: "${DEPLOY_BRANCH:=main}"
: "${DEFER_CADDY_START:=false}"

if (( EUID != 0 )); then
  echo "install-terraform-application.sh는 root로 실행해야 합니다." >&2
  exit 1
fi
for host_value in "$LAB_HOST" "$LAB_LEGACY_HOST"; do
  if [[ -n "$host_value" && ! "$host_value" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "LAB_HOST/LAB_LEGACY_HOST 형식이 올바르지 않습니다." >&2
    exit 1
  fi
done
if [[ ! "$NATIVE_SLOT_COUNT" =~ ^[0-9]+$ ]] \
  || (( 10#$NATIVE_SLOT_COUNT < 1 || 10#$NATIVE_SLOT_COUNT > 20 )); then
  echo "NATIVE_SLOT_COUNT는 1부터 20 사이의 정수여야 합니다." >&2
  exit 1
fi
if [[ "$TERRAFORM_VERSION" != "1.15.8" ]]; then
  echo "이 release에서 검증한 Terraform 버전은 1.15.8입니다." >&2
  exit 1
fi
if [[ "$DEFER_CADDY_START" != "true" && "$DEFER_CADDY_START" != "false" ]]; then
  echo "DEFER_CADDY_START는 true 또는 false여야 합니다." >&2
  exit 1
fi
if [[ "$LAB_ADMIN_EMAIL" == *$'\n'* || "$LAB_ADMIN_EMAIL" != *@* ]]; then
  echo "LAB_ADMIN_EMAIL 형식이 올바르지 않습니다." >&2
  exit 1
fi
if [[ -n "${LAB_ADMIN_PASSWORD:-}" && "$LAB_ADMIN_PASSWORD" == *$'\n'* ]]; then
  echo "LAB_ADMIN_PASSWORD에는 줄바꿈을 사용할 수 없습니다." >&2
  exit 1
fi
if [[ ! -d "${REPOSITORY_DIR}/.git" \
  || ! -f "${REPOSITORY_DIR}/package-lock.json" \
  || ! -x "${REPOSITORY_DIR}/infra/terraform-native-install.sh" ]]; then
  echo "${REPOSITORY_DIR}에 read-only Git checkout이 준비되어 있지 않습니다." >&2
  exit 1
fi
if [[ ! -x /usr/local/bin/terraform-lab-git-ssh \
  || ! -r /etc/terraform-lab/deploy/github_ed25519 \
  || "$(stat -c '%a' /etc/terraform-lab/deploy/github_ed25519)" != "600" ]]; then
  echo "검증된 known_hosts와 root 0600 Deploy Key wrapper가 필요합니다." >&2
  exit 1
fi

set_env_value() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${ENV_DIR}/terraform-lab.env.XXXXXX")"
  awk -v wanted="$key" -v replacement="$value" '
    BEGIN { found = 0 }
    index($0, wanted "=") == 1 {
      if (found == 0) print wanted "=" replacement
      found = 1
      next
    }
    { print }
    END { if (found == 0) print wanted "=" replacement }
  ' "$ENV_FILE" >"$temporary"
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -fT "$temporary" "$ENV_FILE"
}

NATIVE_SLOT_COUNT="$NATIVE_SLOT_COUNT" \
TERRAFORM_VERSION="$TERRAFORM_VERSION" \
  "${REPOSITORY_DIR}/infra/terraform-native-install.sh"

dnf install -y nodejs22 nodejs22-npm 'dnf-command(copr)'
alternatives --set node "$NODE_BIN"
[[ -x "$NODE_BIN" && -x "$NPM_BIN" ]] || {
  echo "Amazon Linux nodejs22/nodejs22-npm 설치에 실패했습니다." >&2
  exit 1
}
if [[ "$("$NODE_BIN" --version | sed -E 's/^v([0-9]+).*/\1/')" != "22" ]]; then
  echo "Node.js 22가 필요합니다." >&2
  exit 1
fi
if ! terraform version -json | jq -e \
  --arg version "$TERRAFORM_VERSION" \
  '.terraform_version == $version and .platform == "linux_amd64"' >/dev/null; then
  echo "Terraform ${TERRAFORM_VERSION} linux_amd64 설치를 확인하지 못했습니다." >&2
  exit 1
fi

if ! rpm -q caddy >/dev/null 2>&1; then
  dnf copr enable -y @caddy/caddy epel-9-x86_64
  dnf install -y caddy
fi

getent passwd "$BUILD_USER" >/dev/null || \
  useradd \
    --system \
    --home-dir "$BUILD_HOME" \
    --create-home \
    --shell /sbin/nologin \
    --comment "Terraform Lab release builder" \
    "$BUILD_USER"

install -d -o root -g root -m 0755 \
  "$APP_ROOT" "$RELEASES_DIR" "$ENV_DIR"
install -d -o terraform-lab -g terraform-lab -m 0700 \
  "$DATA_DIR" "$CONTENT_DIR"
install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 0700 \
  "$BUILD_HOME" "$NPM_CACHE"

if [[ ! -f "${CONTENT_DIR}/course-catalog.yaml" ]]; then
  install -o terraform-lab -g terraform-lab -m 0600 \
    "${REPOSITORY_DIR}/content/course-catalog.yaml" \
    "${CONTENT_DIR}/course-catalog.yaml"
fi

created_environment=false
if [[ ! -f "$ENV_FILE" ]]; then
  auth_secret="$(openssl rand -base64 48 | tr -d '\n')"
  session_secret="$(openssl rand -base64 48 | tr -d '\n')"
  admin_password="${LAB_ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -d '\n')!Aa1}"
  install -o root -g root -m 0600 /dev/null "$ENV_FILE"
  {
    printf 'NODE_ENV=production\n'
    printf 'COURSE_ID=terraform-foundations\n'
    printf 'AUTH_COOKIE_SECRET=%s\n' "$auth_secret"
    printf 'LAB_SESSION_SECRET=%s\n' "$session_secret"
    printf 'AUTH_COOKIE_SECURE=true\n'
    printf 'LAB_STORE_PATH=%s/terraform-lab.json\n' "$DATA_DIR"
    printf 'CATALOG_PATH=%s/course-catalog.yaml\n' "$CONTENT_DIR"
    printf 'MAX_SESSIONS=%s\n' "$NATIVE_SLOT_COUNT"
    printf 'SESSION_TTL_HOURS=4\n'
    printf 'API_RATE_LIMIT_PER_MINUTE=600\n'
    printf 'VALIDATION_RATE_LIMIT_PER_MINUTE=90\n'
    printf 'LAB_HOST=%s\n' "$LAB_HOST"
    printf 'LAB_LEGACY_HOST=%s\n' "$LAB_LEGACY_HOST"
    printf 'LAB_ADMIN_EMAIL=%s\n' "$LAB_ADMIN_EMAIL"
    printf 'LAB_ADMIN_PASSWORD=%s\n' "$admin_password"
    printf 'LAB_ADMIN_NAME=Terraform Lab 관리자\n'
  } >"$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  {
    printf 'URL=https://%s\n' "$LAB_HOST"
    printf 'EMAIL=%s\n' "$LAB_ADMIN_EMAIL"
    printf 'PASSWORD=%s\n' "$admin_password"
    printf '이 파일은 최초 로그인 후 안전한 암호 저장소로 옮기고 삭제하세요.\n'
  } >"$INITIAL_CREDENTIAL_FILE"
  chmod 0600 "$INITIAL_CREDENTIAL_FILE"
  created_environment=true
else
  set_env_value COURSE_ID terraform-foundations
  set_env_value LAB_HOST "$LAB_HOST"
  set_env_value LAB_LEGACY_HOST "$LAB_LEGACY_HOST"
  set_env_value MAX_SESSIONS "$NATIVE_SLOT_COUNT"
fi

git -C "$REPOSITORY_DIR" config core.sshCommand /usr/local/bin/terraform-lab-git-ssh
git -C "$REPOSITORY_DIR" fetch --prune origin \
  "+refs/heads/${DEPLOY_BRANCH}:refs/remotes/origin/${DEPLOY_BRANCH}"
target_commit="$(git -C "$REPOSITORY_DIR" rev-parse --verify "origin/${DEPLOY_BRANCH}^{commit}")"
readonly target_commit
readonly release_dir="${RELEASES_DIR}/${target_commit}"
readonly release_marker="${release_dir}/.terraform-lab-release-ready"

if [[ ! -r "$release_marker" \
  || "$(tr -d '\n' <"$release_marker" 2>/dev/null || true)" != "$target_commit" ]]; then
  if [[ -e "$release_dir" ]]; then
    failed_release="${release_dir}.failed.$(date -u +%Y%m%dT%H%M%SZ).$$"
    mv -- "$release_dir" "$failed_release"
    git -C "$REPOSITORY_DIR" worktree prune
  fi
  git -C "$REPOSITORY_DIR" worktree add --detach "$release_dir" "$target_commit"
  chown -R "${BUILD_USER}:${BUILD_USER}" "$release_dir"
  (
    cd "$release_dir"
    sudo -u "$BUILD_USER" env HOME="$BUILD_HOME" npm_config_cache="$NPM_CACHE" \
      "$NPM_BIN" ci --no-audit --no-fund
    sudo -u "$BUILD_USER" env HOME="$BUILD_HOME" npm_config_cache="$NPM_CACHE" \
      "$NPM_BIN" test -- --maxWorkers=1
    sudo -u "$BUILD_USER" env HOME="$BUILD_HOME" npm_config_cache="$NPM_CACHE" \
      "$NPM_BIN" run build
    sudo -u "$BUILD_USER" env HOME="$BUILD_HOME" npm_config_cache="$NPM_CACHE" \
      "$NPM_BIN" prune --omit=dev --no-audit --no-fund
  )
  "$NODE_BIN" --check "${release_dir}/dist-server/index.js"
  chown -R root:root "$release_dir"
  chmod -R a+rX,go-w "$release_dir"
  sudo -u terraform-lab test -r "${release_dir}/dist-server/index.js"
  sudo -u terraform-lab test -r "${release_dir}/dist/index.html"
  sudo -u terraform-lab env -i \
    HOME="$DATA_DIR" \
    PATH=/usr/local/bin:/usr/bin:/bin \
    LANG=C.UTF-8 \
    MAX_SESSIONS="$NATIVE_SLOT_COUNT" \
    /usr/bin/timeout --signal=TERM --kill-after=75s 2400s \
    "$NODE_BIN" "${release_dir}/dist-server/terraform-curriculum-smoke.js"
  printf '%s\n' "$target_commit" >"$release_marker"
  chmod 0444 "$release_marker"
fi

set_env_value APP_COMMIT_SHA "$target_commit"
ln -sfn "$release_dir" "${CURRENT_LINK}.candidate"
mv -fT "${CURRENT_LINK}.candidate" "$CURRENT_LINK"
[[ "$(readlink -f "$CURRENT_LINK")" == "$release_dir" ]] || {
  echo "활성 release symlink 전환에 실패했습니다." >&2
  exit 1
}

install -o root -g root -m 0644 \
  "${release_dir}/infra/systemd/terraform-lab-web.service" \
  /etc/systemd/system/terraform-lab-web.service
install -o root -g root -m 0644 \
  "${release_dir}/infra/systemd/terraform-lab.slice" \
  /etc/systemd/system/terraform-lab.slice
install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d
cat >/etc/systemd/system/caddy.service.d/terraform-lab.conf <<EOF
[Service]
Environment=LAB_HOST=${LAB_HOST}
Environment=LAB_LEGACY_HOST=${LAB_LEGACY_HOST}
EOF
chmod 0644 /etc/systemd/system/caddy.service.d/terraform-lab.conf

systemctl daemon-reload
systemd-analyze verify \
  /etc/systemd/system/terraform-lab.slice \
  /etc/systemd/system/terraform-lab-web.service
systemctl enable --now terraform-lab-reaper.timer
systemctl enable terraform-lab-web.service
systemctl restart terraform-lab-web.service

local_health="$(curl -fsS --retry 30 --retry-delay 1 --retry-all-errors \
  --connect-timeout 3 --max-time 10 http://127.0.0.1:3000/healthz)"
jq -e --arg commit "$target_commit" \
  '.ok == true and .runtime == "native" and
   .runtimeKind == "terraform-native" and
   .courseId == "terraform-foundations" and .version == $commit' \
  <<<"$local_health" >/dev/null

if grep -q '^LAB_ADMIN_PASSWORD=' "$ENV_FILE"; then
  temporary_env="$(mktemp "${ENV_DIR}/terraform-lab.env.XXXXXX")"
  grep -v '^LAB_ADMIN_\(EMAIL\|PASSWORD\|NAME\)=' "$ENV_FILE" >"$temporary_env"
  chmod 0600 "$temporary_env"
  chown root:root "$temporary_env"
  mv -fT "$temporary_env" "$ENV_FILE"
  systemctl restart terraform-lab-web.service
fi

PUBLIC_SMOKE=false "${release_dir}/infra/terraform-smoke-deployment.sh"
if [[ "$DEFER_CADDY_START" == "false" ]]; then
  LAB_HOST="$LAB_HOST" "${release_dir}/infra/terraform-cutover-caddy.sh"
fi

echo "Terraform Lab 네이티브 설치가 완료되었습니다: https://${LAB_HOST}"
if [[ "$created_environment" == "true" ]]; then
  echo "최초 관리자 정보: ${INITIAL_CREDENTIAL_FILE} (root 0600)"
fi
