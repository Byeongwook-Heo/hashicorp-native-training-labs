#!/usr/bin/env bash
set -euo pipefail

umask 0022

readonly RELEASE_DIR="${1:-/opt/vault-lab/current}"
readonly SYSTEMD_DIR="/etc/systemd/system"
readonly SLICE_DROP_IN_CONTENT='[Service]
Slice=vault-lab.slice'

if (( EUID != 0 )); then
  echo "install-systemd-units.sh는 root로 실행해야 합니다." >&2
  exit 1
fi
if [[ ! -f /usr/bin/setpriv \
  || -L /usr/bin/setpriv \
  || ! -x /usr/bin/setpriv \
  || "$(stat -c '%u:%g:%a' /usr/bin/setpriv)" != "0:0:755" ]]; then
  echo "root 소유의 실행 가능한 /usr/bin/setpriv가 필요합니다." >&2
  exit 1
fi
if [[ ! -f "${RELEASE_DIR}/infra/systemd/vault-lab-web.service" \
  || ! -f "${RELEASE_DIR}/infra/systemd/vault-lab.slice" ]]; then
  echo "${RELEASE_DIR}에 systemd 배포 파일이 없습니다." >&2
  exit 1
fi
if [[ ! -f "${SYSTEMD_DIR}/vault-lab@.service" \
  || ! -f "${SYSTEMD_DIR}/vault-lab-loopback.service" \
  || ! -f "${SYSTEMD_DIR}/vault-lab-storage.target" ]]; then
  echo "먼저 infra/native-install.sh로 Vault 세션 unit을 설치해야 합니다." >&2
  exit 1
fi

install -o root -g root -m 0644 \
  "${RELEASE_DIR}/infra/systemd/vault-lab-web.service" \
  "${SYSTEMD_DIR}/vault-lab-web.service"
install -o root -g root -m 0644 \
  "${RELEASE_DIR}/infra/systemd/vault-lab.slice" \
  "${SYSTEMD_DIR}/vault-lab.slice"

for drop_in_dir in \
  "${SYSTEMD_DIR}/vault-lab@.service.d" \
  "${SYSTEMD_DIR}/vault-lab-terminal-.service.d" \
  "${SYSTEMD_DIR}/vault-lab-exec-.service.d"; do
  install -d -o root -g root -m 0755 "$drop_in_dir"
  printf '%s\n' "$SLICE_DROP_IN_CONTENT" \
    >"${drop_in_dir}/20-vault-lab-slice.conf"
  chmod 0644 "${drop_in_dir}/20-vault-lab-slice.conf"
done

systemctl daemon-reload
systemd-analyze verify \
  "${SYSTEMD_DIR}/vault-lab.slice" \
  "${SYSTEMD_DIR}/vault-lab-web.service" \
  "${SYSTEMD_DIR}/vault-lab-loopback.service" \
  "${SYSTEMD_DIR}/vault-lab@.service"

echo "Vault Lab systemd unit과 aggregate slice를 설치했습니다."
