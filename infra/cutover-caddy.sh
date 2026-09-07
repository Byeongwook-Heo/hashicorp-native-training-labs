#!/usr/bin/env bash
set -Eeuo pipefail

umask 0022

readonly CURRENT_DIR="/opt/vault-lab/current"
readonly ENV_FILE="/etc/vault-lab/vault-lab.env"
readonly CADDY_CONFIG="/etc/caddy/Caddyfile"
: "${LAB_HOST:=}"
: "${LAB_LEGACY_HOST:=}"

if (( EUID != 0 )); then
  echo "cutover-caddy.sh는 root로 실행해야 합니다." >&2
  exit 1
fi
[[ -r "${CURRENT_DIR}/Caddyfile" ]] || {
  echo "활성 release의 Caddyfile을 찾을 수 없습니다." >&2
  exit 1
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

if [[ -z "$LAB_HOST" ]]; then
  LAB_HOST="$(read_env_value LAB_HOST)"
fi
if [[ -z "$LAB_LEGACY_HOST" ]]; then
  LAB_LEGACY_HOST="$(read_env_value LAB_LEGACY_HOST)"
fi
for host_value in "$LAB_HOST" "$LAB_LEGACY_HOST"; do
  if [[ -n "$host_value" && ! "$host_value" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "LAB_HOST/LAB_LEGACY_HOST 형식이 올바르지 않습니다." >&2
    exit 1
  fi
done
[[ -n "$LAB_HOST" ]] || {
  echo "LAB_HOST가 필요합니다." >&2
  exit 1
}
export LAB_HOST LAB_LEGACY_HOST

PUBLIC_SMOKE=false "${CURRENT_DIR}/infra/smoke-deployment.sh"
caddy validate --config "${CURRENT_DIR}/Caddyfile" --adapter caddyfile

caddy_was_active=false
if systemctl is-active --quiet caddy.service; then
  caddy_was_active=true
else
  listeners="$(ss -H -ltn '( sport = :80 or sport = :443 )')"
  if [[ -n "$listeners" ]]; then
    echo "80/443 포트를 사용하는 기존 listener가 있습니다." >&2
    echo "기존 프록시를 정상 종료한 뒤 이 스크립트를 다시 실행하세요." >&2
    exit 1
  fi
fi
caddy_was_enabled=false
if systemctl is-enabled --quiet caddy.service; then
  caddy_was_enabled=true
fi

backup_file="$(mktemp /etc/caddy/Caddyfile.rollback.XXXXXX)"
had_previous_config=false
if [[ -f "$CADDY_CONFIG" ]]; then
  cp -a "$CADDY_CONFIG" "$backup_file"
  had_previous_config=true
fi

rollback() {
  local status=$?
  trap - ERR
  set +e
  if [[ "$had_previous_config" == "true" ]]; then
    cp -a "$backup_file" "$CADDY_CONFIG"
    if [[ "$caddy_was_active" == "true" ]]; then
      systemctl restart caddy.service
    else
      systemctl stop caddy.service
    fi
  else
    systemctl stop caddy.service
    rm -f "$CADDY_CONFIG"
  fi
  if [[ "$caddy_was_enabled" == "true" ]]; then
    systemctl enable caddy.service
  else
    systemctl disable caddy.service
  fi
  rm -f "$backup_file"
  echo "Caddy 전환에 실패해 이전 구성을 복구했습니다." >&2
  exit "$status"
}
trap rollback ERR

install -o root -g root -m 0644 "${CURRENT_DIR}/Caddyfile" "$CADDY_CONFIG"
caddy validate --config "$CADDY_CONFIG" --adapter caddyfile
systemctl enable caddy.service
systemctl restart caddy.service
PUBLIC_SMOKE=true LAB_HOST="$LAB_HOST" \
  "${CURRENT_DIR}/infra/smoke-deployment.sh"

trap - ERR
rm -f "$backup_file"
echo "Caddy 전환과 외부 HTTPS/WSS smoke를 완료했습니다."
