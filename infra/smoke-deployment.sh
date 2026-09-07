#!/usr/bin/env bash
set -euo pipefail

readonly ENV_FILE="/etc/vault-lab/vault-lab.env"
readonly CURRENT_DIR="/opt/vault-lab/current"
readonly NODE_BIN="/usr/bin/node-22"
: "${PUBLIC_SMOKE:=true}"
: "${LAB_HOST:=}"
: "${EXPECTED_COMMIT:=}"

if [[ "$PUBLIC_SMOKE" != "true" && "$PUBLIC_SMOKE" != "false" ]]; then
  echo "PUBLIC_SMOKE는 true 또는 false여야 합니다." >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  [[ -r "$ENV_FILE" ]] || return 0
  awk -F= -v wanted="$key" '
    $1 == wanted {
      sub(/^[^=]*=/, "", $0)
      print
      exit
    }
  ' "$ENV_FILE"
}

smoke_fail() {
  echo "Vault Lab deployment smoke 실패: $*" >&2
  exit 1
}

if [[ -z "$LAB_HOST" ]]; then
  LAB_HOST="$(read_env_value LAB_HOST)"
fi
if [[ -z "$EXPECTED_COMMIT" ]]; then
  EXPECTED_COMMIT="$(read_env_value APP_COMMIT_SHA)"
fi
if [[ -n "$LAB_HOST" && ! "$LAB_HOST" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "LAB_HOST 형식이 올바르지 않습니다." >&2
  exit 1
fi
if [[ -n "$EXPECTED_COMMIT" && ! "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo "EXPECTED_COMMIT 형식이 올바르지 않습니다." >&2
  exit 1
fi

systemctl is-active --quiet vault-lab-web.service \
  || smoke_fail "web service가 active가 아닙니다."
local_health="$(curl -fsS --retry 20 --retry-delay 1 --retry-all-errors \
  --connect-timeout 3 --max-time 10 \
  http://127.0.0.1:3000/healthz)"
jq -e \
  --arg expected "$EXPECTED_COMMIT" \
  '.ok == true
    and .runtime == "native"
    and ($expected == "" or .version == $expected)' \
  <<<"$local_health" >/dev/null \
  || smoke_fail "local health 응답이 예상 release와 일치하지 않습니다."
web_pid="$(systemctl show -p MainPID --value vault-lab-web.service)"
[[ "$web_pid" =~ ^[1-9][0-9]*$ && -r "/proc/${web_pid}/status" ]] \
  || smoke_fail "web MainPID 상태를 읽을 수 없습니다."
web_uid="$(id -u vault-lab)"
read -r real_uid effective_uid saved_uid filesystem_uid < <(
  awk '/^Uid:/ { print $2, $3, $4, $5 }' "/proc/${web_pid}/status"
)
[[ "$real_uid" == "$web_uid" \
  && "$effective_uid" == "$web_uid" \
  && "$saved_uid" == "$web_uid" \
  && "$filesystem_uid" == "$web_uid" ]] \
  || smoke_fail "web UID 경계가 vault-lab으로 완전히 하향되지 않았습니다."
[[ "$(awk '/^CapEff:/ { print $2 }' "/proc/${web_pid}/status")" \
  == "0000000000000000" ]] \
  || smoke_fail "web effective capability가 0이 아닙니다."
[[ "$(awk '/^CapPrm:/ { print $2 }' "/proc/${web_pid}/status")" \
  == "0000000000000000" ]] \
  || smoke_fail "web permitted capability가 0이 아닙니다."
[[ "$(awk '/^CapAmb:/ { print $2 }' "/proc/${web_pid}/status")" \
  == "0000000000000000" ]] \
  || smoke_fail "web ambient capability가 0이 아닙니다."
[[ "$(awk '/^NoNewPrivs:/ { print $2 }' "/proc/${web_pid}/status")" == "0" ]] \
  || smoke_fail "web no_new_privs가 sudo control broker를 차단합니다."
[[ "$(systemctl show -p ProcSubset --value vault-lab-web.service)" == "all" ]] \
  || smoke_fail "web ProcSubset이 all이 아닙니다."
nsenter -t "$web_pid" -m -- test -r /proc/sys/kernel/random/uuid \
  || smoke_fail "web mount namespace에서 kernel UUID를 읽을 수 없습니다."
[[ -n "$(
  nsenter -t "$web_pid" -m -- head -c 36 /proc/sys/kernel/random/uuid
)" ]] || smoke_fail "web mount namespace의 kernel UUID가 비어 있습니다."
terminal_count="$(
  sudo -u vault-lab \
    sudo -n /usr/local/sbin/vault-lab-control terminal-count s01
)"
[[ "$terminal_count" =~ ^[0-9]+$ ]] \
  || smoke_fail "sudo control broker의 terminal-count가 유효하지 않습니다."
[[ "$(systemctl show -p MainPID --value vault-lab-web.service)" == "$web_pid" ]] \
  || smoke_fail "web service PID가 경계 검사 중 변경되었습니다."

if [[ "$PUBLIC_SMOKE" == "true" ]]; then
  [[ -n "$LAB_HOST" ]] || {
    echo "public smoke에는 LAB_HOST가 필요합니다." >&2
    exit 1
  }
  systemctl is-active --quiet caddy.service
  public_health="$(curl -fsS --retry 30 --retry-delay 2 --retry-all-errors \
    --connect-timeout 5 --max-time 15 \
    --resolve "${LAB_HOST}:443:127.0.0.1" \
    "https://${LAB_HOST}/healthz")"
  jq -e \
    --arg expected "$EXPECTED_COMMIT" \
    '.ok == true
      and .runtime == "native"
      and ($expected == "" or .version == $expected)' \
    <<<"$public_health" >/dev/null

  RELEASE_DIR="$CURRENT_DIR" LAB_HOST="$LAB_HOST" \
    timeout 30 "$NODE_BIN" --input-type=module <<'NODE'
import path from "node:path";
import { pathToFileURL } from "node:url";

const wsModule = pathToFileURL(
  path.join(process.env.RELEASE_DIR, "node_modules/ws/wrapper.mjs")
).href;
const { default: WebSocket } = await import(wsModule);
const host = process.env.LAB_HOST;

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("WSS smoke 시간이 초과되었습니다.")), 20_000);
  const socket = new WebSocket(`wss://${host}/terminal`, {
    headers: { Origin: `https://${host}` },
    lookup: (_hostname, options, callback) => {
      if (options?.all) {
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
        return;
      }
      callback(null, "127.0.0.1", 4);
    }
  });
  let opened = false;
  socket.once("open", () => {
    opened = true;
  });
  socket.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  socket.once("close", (code) => {
    clearTimeout(timer);
    if (!opened) {
      reject(new Error("WSS 연결이 열리기 전에 종료되었습니다."));
      return;
    }
    if (code !== 4401) {
      reject(new Error(`인증 전 WSS의 예상 종료 코드는 4401이지만 ${code}를 받았습니다.`));
      return;
    }
    resolve();
  });
});
NODE
fi

if [[ "$PUBLIC_SMOKE" == "true" ]]; then
  echo "Vault Lab HTTP·HTTPS·WSS smoke를 통과했습니다."
else
  echo "Vault Lab local HTTP smoke를 통과했습니다."
fi
