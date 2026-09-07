#!/usr/bin/env bash
set -Eeuo pipefail

umask 0022

readonly APP_ROOT="/opt/vault-lab"
readonly REPOSITORY_DIR="${APP_ROOT}/repository"
readonly ENV_DIR="/etc/vault-lab"
readonly ENV_FILE="${ENV_DIR}/vault-lab.env"
readonly DATA_DIR="/var/lib/vault-lab/app"
readonly CONTENT_DIR="/var/lib/vault-lab/content"
readonly INITIAL_CREDENTIAL_FILE="/root/vault-lab-initial-admin.txt"
readonly NODE_BIN="/usr/bin/node-22"
readonly NPM_BIN="/usr/bin/npm-22"

: "${LAB_HOST:?LAB_HOST가 필요합니다. 예: 52-79-170-130.sslip.io}"
LAB_LEGACY_HOST="${LAB_LEGACY_HOST-}"
: "${NATIVE_SLOT_COUNT:=4}"
: "${VAULT_VERSION:=2.0.3}"
: "${LAB_ADMIN_EMAIL:=admin@vault-lab.local}"
: "${DEPLOY_BRANCH:=main}"
: "${DEFER_CADDY_START:=false}"

if (( EUID != 0 )); then
  echo "install-application.sh는 root로 실행해야 합니다." >&2
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
if [[ "$VAULT_VERSION" != "2.0.3" ]]; then
  echo "이 release에서 검증한 Vault 버전은 2.0.3입니다." >&2
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
  || ! -x "${REPOSITORY_DIR}/infra/native-install.sh" ]]; then
  echo "${REPOSITORY_DIR}에 read-only Git checkout이 준비되어 있지 않습니다." >&2
  exit 1
fi
if [[ ! -x /usr/local/bin/vault-lab-git-ssh \
  || ! -r /etc/vault-lab/deploy/github_ed25519 ]]; then
  echo "검증된 known_hosts와 root 0600 Deploy Key wrapper가 필요합니다." >&2
  exit 1
fi
deploy_key_mode="$(stat -c '%a' /etc/vault-lab/deploy/github_ed25519)"
if [[ "$deploy_key_mode" != "600" ]]; then
  echo "GitHub Deploy Key mode는 0600이어야 합니다." >&2
  exit 1
fi

set_env_value() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${ENV_DIR}/vault-lab.env.XXXXXX")"
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

NATIVE_SLOT_COUNT="$NATIVE_SLOT_COUNT" \
VAULT_VERSION="$VAULT_VERSION" \
  "${REPOSITORY_DIR}/infra/native-install.sh"

dnf install -y nodejs22 nodejs22-npm
alternatives --set node "$NODE_BIN"
[[ -x "$NODE_BIN" && -x "$NPM_BIN" ]] || {
  echo "Amazon Linux nodejs22/nodejs22-npm 설치에 실패했습니다." >&2
  exit 1
}
node_major="$("$NODE_BIN" --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "$node_major" != "22" ]]; then
  echo "Node.js 22가 필요합니다. 현재: $("$NODE_BIN" --version)" >&2
  exit 1
fi
if ! /usr/local/bin/vault version | grep -q 'Vault v2\.0\.3'; then
  echo "Vault 2.0.3 설치를 확인하지 못했습니다." >&2
  exit 1
fi

dnf install -y 'dnf-command(copr)'
if ! rpm -q caddy >/dev/null 2>&1; then
  # AL2023 has no native COPR chroot mapping. The official Caddy EL9 build
  # targets glibc 2.34, which matches AL2023, so select it explicitly.
  dnf copr enable -y @caddy/caddy epel-9-x86_64
  dnf install -y caddy
fi

getent passwd vault-lab-build >/dev/null || \
  useradd \
    --system \
    --home-dir /var/lib/vault-lab-build \
    --create-home \
    --shell /sbin/nologin \
    --comment "Vault Lab release builder" \
    vault-lab-build

install -d -o root -g root -m 0755 \
  "$APP_ROOT" \
  "${APP_ROOT}/releases" \
  "$ENV_DIR"
install -d -o vault-lab -g vault-lab -m 0700 "$DATA_DIR" "$CONTENT_DIR"
install -d -o vault-lab-build -g vault-lab-build -m 0700 \
  /var/lib/vault-lab-build \
  /var/cache/vault-lab/npm

if [[ ! -f "${CONTENT_DIR}/course-catalog.yaml" ]]; then
  install -o vault-lab -g vault-lab -m 0600 \
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
    printf 'AUTH_COOKIE_SECRET=%s\n' "$auth_secret"
    printf 'LAB_SESSION_SECRET=%s\n' "$session_secret"
    printf 'AUTH_COOKIE_SECURE=true\n'
    printf 'LAB_STORE_PATH=%s/vault-lab.json\n' "$DATA_DIR"
    printf 'CATALOG_PATH=%s/course-catalog.yaml\n' "$CONTENT_DIR"
    printf 'MAX_SESSIONS=%s\n' "$NATIVE_SLOT_COUNT"
    printf 'SESSION_TTL_HOURS=4\n'
    printf 'API_RATE_LIMIT_PER_MINUTE=600\n'
    printf 'VALIDATION_RATE_LIMIT_PER_MINUTE=90\n'
    printf 'LAB_HOST=%s\n' "$LAB_HOST"
    printf 'LAB_LEGACY_HOST=%s\n' "$LAB_LEGACY_HOST"
    printf 'LAB_ADMIN_EMAIL=%s\n' "$LAB_ADMIN_EMAIL"
    printf 'LAB_ADMIN_PASSWORD=%s\n' "$admin_password"
    printf 'LAB_ADMIN_NAME=Vault Lab 관리자\n'
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
  set_env_value LAB_HOST "$LAB_HOST"
  set_env_value LAB_LEGACY_HOST "$LAB_LEGACY_HOST"
  set_env_value MAX_SESSIONS "$NATIVE_SLOT_COUNT"
fi

install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d
cat >/etc/systemd/system/caddy.service.d/vault-lab.conf <<EOF
[Service]
Environment=LAB_HOST=${LAB_HOST}
Environment=LAB_LEGACY_HOST=${LAB_LEGACY_HOST}
EOF
chmod 0644 /etc/systemd/system/caddy.service.d/vault-lab.conf

git -C "$REPOSITORY_DIR" config \
  core.sshCommand /usr/local/bin/vault-lab-git-ssh
"${REPOSITORY_DIR}/infra/install-systemd-units.sh" "$REPOSITORY_DIR"

run_native_smoke=false
if ! systemctl is-active --quiet vault-lab-web.service; then
  run_native_smoke=true
fi

DEPLOY_BRANCH="$DEPLOY_BRANCH" \
RUN_NATIVE_SMOKE="$run_native_smoke" \
DEFER_CADDY_START="$DEFER_CADDY_START" \
  "${REPOSITORY_DIR}/infra/update-from-git.sh"

if grep -q '^LAB_ADMIN_PASSWORD=' "$ENV_FILE"; then
  temporary_env="$(mktemp "${ENV_DIR}/vault-lab.env.XXXXXX")"
  grep -v '^LAB_ADMIN_\(EMAIL\|PASSWORD\|NAME\)=' "$ENV_FILE" >"$temporary_env"
  chmod 0600 "$temporary_env"
  chown root:root "$temporary_env"
  mv -f "$temporary_env" "$ENV_FILE"
  systemctl restart vault-lab-web.service
fi

PUBLIC_SMOKE=false /opt/vault-lab/current/infra/smoke-deployment.sh
if [[ "$DEFER_CADDY_START" == "false" ]]; then
  PUBLIC_SMOKE=true LAB_HOST="$LAB_HOST" \
    /opt/vault-lab/current/infra/smoke-deployment.sh
fi

echo "Vault Lab 네이티브 설치가 완료되었습니다: https://${LAB_HOST}"
if [[ "$DEFER_CADDY_START" == "true" ]]; then
  echo "Caddy 시작은 보류되었습니다. 기존 프록시가 포트를 놓은 뒤 infra/cutover-caddy.sh를 실행하세요."
fi
if [[ "$created_environment" == "true" ]]; then
  echo "최초 관리자 정보: ${INITIAL_CREDENTIAL_FILE} (root 0600)"
fi
