#!/usr/bin/env bash
set -Eeuo pipefail

readonly CURRENT_DIR=/opt/terraform-lab/current
readonly WEB_SERVICE=terraform-lab-web.service
readonly NODE_BIN=/usr/bin/node-22
readonly DATA_DIR=/var/lib/terraform-lab/app
readonly ENV_FILE=/etc/terraform-lab/terraform-lab.env
readonly RUNTIME_ROOT=/run/terraform-lab/slots
restart_web=false

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$restart_web" == "true" ]]; then
    systemctl start "$WEB_SERVICE"
  fi
  exit "$status"
}
trap cleanup EXIT

if (( EUID != 0 )); then
  echo "Terraform reboot smoke must run as root." >&2
  exit 1
fi
[[ -x "${CURRENT_DIR}/infra/terraform-smoke-deployment.sh" \
  && -r "${CURRENT_DIR}/dist-server/terraform-curriculum-smoke.js" \
  && -r "$ENV_FILE" ]] || {
  echo "Terraform reboot smoke assets are unavailable." >&2
  exit 1
}
native_slot_count="$(awk -F= '$1 == "MAX_SESSIONS" {print $2; exit}' "$ENV_FILE")"
if [[ ! "$native_slot_count" =~ ^[0-9]+$ ]] \
  || (( 10#$native_slot_count < 1 || 10#$native_slot_count > 20 )); then
  echo "Terraform reboot smoke slot count is invalid." >&2
  exit 1
fi

systemctl stop "$WEB_SERVICE"
restart_web=true
sudo -u terraform-lab env -i \
  HOME="$DATA_DIR" \
  PATH=/usr/local/bin:/usr/bin:/bin \
  LANG=C.UTF-8 \
  MAX_SESSIONS="$native_slot_count" \
  TERRAFORM_SMOKE_MODE=first-session \
  /usr/bin/timeout --signal=TERM --kill-after=15s 300s \
  "$NODE_BIN" "${CURRENT_DIR}/dist-server/terraform-curriculum-smoke.js"
systemctl start "$WEB_SERVICE"
restart_web=false

PUBLIC_SMOKE=false "${CURRENT_DIR}/infra/terraform-smoke-deployment.sh"
systemctl is-active --quiet terraform-lab-storage.target
systemctl is-active --quiet terraform-lab-reaper.timer
[[ "$(systemctl show -p Result --value systemd-tmpfiles-setup.service)" == "success" ]]
[[ "$(systemctl show -p Result --value "$WEB_SERVICE")" == "success" ]]
[[ "$(systemctl show -p NRestarts --value "$WEB_SERVICE")" == "0" ]]
[[ "$(findmnt -rn -M /run -o FSTYPE)" == "tmpfs" ]]
if journalctl -b -u "$WEB_SERVICE" --no-pager \
  | grep -E 'slot runtime directory is unsafe|failed to start|Native Terraform session cleanup failed' \
  >/dev/null; then
  echo "Terraform web journal contains a post-reboot runtime failure." >&2
  exit 1
fi
running_scopes="$(systemctl list-units \
  --all --state=running --full --plain --no-legend \
  'terraform-lab-terminal-*.service' \
  'terraform-lab-command-*.service')"
[[ -z "$running_scopes" ]] || {
  echo "Terraform transient command scopes remain active after smoke." >&2
  exit 1
}
if find "$RUNTIME_ROOT" -mindepth 2 -maxdepth 2 -type f -print -quit \
  | grep -q .; then
  echo "Terraform session metadata remains after reboot smoke cleanup." >&2
  exit 1
fi
echo "Terraform post-reboot first-session smoke passed."
