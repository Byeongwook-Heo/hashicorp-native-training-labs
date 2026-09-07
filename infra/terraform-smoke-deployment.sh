#!/usr/bin/env bash
set -euo pipefail

readonly ENV_FILE="/etc/terraform-lab/terraform-lab.env"
readonly CURRENT_DIR="/opt/terraform-lab/current"
readonly NODE_BIN="/usr/bin/node-22"
readonly TMPFILES_CONFIG="/etc/tmpfiles.d/terraform-lab.conf"
readonly AGENT_SKILLS_ROOT="/opt/terraform-lab/agent-skills"
readonly AGENT_SKILLS_COMMIT="4451ceca5456e79cc776efee96a744f7ac96e5bf"
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
    $1 == wanted { sub(/^[^=]*=/, "", $0); print; exit }
  ' "$ENV_FILE"
}

smoke_fail() {
  echo "Terraform Lab deployment smoke 실패: $*" >&2
  exit 1
}

if [[ -z "$LAB_HOST" ]]; then
  LAB_HOST="$(read_env_value LAB_HOST)"
fi
if [[ -z "$EXPECTED_COMMIT" ]]; then
  EXPECTED_COMMIT="$(read_env_value APP_COMMIT_SHA)"
fi
if [[ -n "$LAB_HOST" && ! "$LAB_HOST" =~ ^[A-Za-z0-9.-]+$ ]]; then
  smoke_fail "LAB_HOST 형식이 올바르지 않습니다."
fi
if [[ -n "$EXPECTED_COMMIT" && ! "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  smoke_fail "EXPECTED_COMMIT 형식이 올바르지 않습니다."
fi

native_slot_count="$(read_env_value MAX_SESSIONS)"
if [[ ! "$native_slot_count" =~ ^[0-9]+$ ]] \
  || (( 10#$native_slot_count < 1 || 10#$native_slot_count > 20 )); then
  smoke_fail "MAX_SESSIONS 슬롯 수가 올바르지 않습니다."
fi
[[ -f "$TMPFILES_CONFIG" && ! -L "$TMPFILES_CONFIG" \
  && "$(stat -c '%u:%g:%a' "$TMPFILES_CONFIG")" == "0:0:644" ]] \
  || smoke_fail "tmpfiles 설정 메타데이터가 안전하지 않습니다."
app_uid="$(id -u terraform-lab)" \
  || smoke_fail "terraform-lab 사용자를 확인할 수 없습니다."
for (( index=1; index<=10#$native_slot_count; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  runtime_dir="/run/terraform-lab/slots/${slot}"
  slot_gid="$(id -g "tflab-${slot}")" \
    || smoke_fail "${slot} 사용자를 확인할 수 없습니다."
  [[ -d "$runtime_dir" && ! -L "$runtime_dir" \
    && "$(stat -c '%u:%g:%a' "$runtime_dir")" \
      == "${app_uid}:${slot_gid}:2750" ]] \
    || smoke_fail "${slot} 런타임 디렉터리 계약이 깨졌습니다."
  grep -Fqx -- \
    "d ${runtime_dir} 2750 terraform-lab tflab-${slot} -" \
    "$TMPFILES_CONFIG" \
    || smoke_fail "${slot} 재부팅 복원 항목이 없습니다."
done

systemctl is-active --quiet terraform-lab-web.service \
  || smoke_fail "web service가 active가 아닙니다."
systemctl is-active --quiet terraform-lab-reaper.timer \
  || smoke_fail "TTL reaper timer가 active가 아닙니다."

local_health="$(curl -fsS --retry 20 --retry-delay 1 --retry-all-errors \
  --connect-timeout 3 --max-time 10 http://127.0.0.1:3000/healthz)"
jq -e --arg expected "$EXPECTED_COMMIT" '
  .ok == true and
  .runtime == "native" and
  .runtimeKind == "terraform-native" and
  .courseId == "terraform-foundations" and
  ($expected == "" or .version == $expected)
' <<<"$local_health" >/dev/null \
  || smoke_fail "local health 응답이 Terraform release와 일치하지 않습니다."

web_pid="$(systemctl show -p MainPID --value terraform-lab-web.service)"
[[ "$web_pid" =~ ^[1-9][0-9]*$ && -r "/proc/${web_pid}/status" ]] \
  || smoke_fail "web MainPID 상태를 읽을 수 없습니다."
web_uid="$(id -u terraform-lab)"
read -r real_uid effective_uid saved_uid filesystem_uid < <(
  awk '/^Uid:/ { print $2, $3, $4, $5 }' "/proc/${web_pid}/status"
)
[[ "$real_uid" == "$web_uid" \
  && "$effective_uid" == "$web_uid" \
  && "$saved_uid" == "$web_uid" \
  && "$filesystem_uid" == "$web_uid" ]] \
  || smoke_fail "web UID 경계가 terraform-lab으로 완전히 하향되지 않았습니다."
for capability_field in CapEff CapPrm CapAmb; do
  [[ "$(awk -v field="${capability_field}:" '$1 == field { print $2 }' "/proc/${web_pid}/status")" \
    == "0000000000000000" ]] \
    || smoke_fail "web ${capability_field} capability가 0이 아닙니다."
done
[[ "$(awk '/^NoNewPrivs:/ { print $2 }' "/proc/${web_pid}/status")" == "0" ]] \
  || smoke_fail "web no_new_privs가 control broker를 차단합니다."

terraform version -json | jq -e \
  '.terraform_version == "1.15.8" and .platform == "linux_amd64"' >/dev/null \
  || smoke_fail "고정 Terraform CLI가 설치되지 않았습니다."
[[ -r /etc/terraform-lab/terraform.rc \
  && "$(stat -c '%u:%g:%a' /etc/terraform-lab/terraform.rc)" == "0:0:444" ]] \
  || smoke_fail "root-owned Terraform CLI config 계약이 깨졌습니다."
[[ -r /opt/terraform-lab/providers/manifest.sha256 \
  && "$(stat -c '%u:%g:%a' /opt/terraform-lab/providers/manifest.sha256)" == "0:0:444" ]] \
  || smoke_fail "provider mirror manifest 계약이 깨졌습니다."
(cd /opt/terraform-lab/providers && sha256sum -c manifest.sha256 >/dev/null) \
  || smoke_fail "provider mirror checksum 검증에 실패했습니다."

[[ -d "$AGENT_SKILLS_ROOT" && ! -L "$AGENT_SKILLS_ROOT" \
  && "$(stat -c '%u:%g:%a' "$AGENT_SKILLS_ROOT")" == "0:0:555" ]] \
  || smoke_fail "Agent Skills root 소유권·mode 계약이 깨졌습니다."
[[ -f "$AGENT_SKILLS_ROOT/.upstream-commit" \
  && ! -L "$AGENT_SKILLS_ROOT/.upstream-commit" \
  && "$(stat -c '%u:%g:%a' "$AGENT_SKILLS_ROOT/.upstream-commit")" \
    == "0:0:444" \
  && "$(cat "$AGENT_SKILLS_ROOT/.upstream-commit")" \
    == "$AGENT_SKILLS_COMMIT" ]] \
  || smoke_fail "Agent Skills upstream commit 계약이 깨졌습니다."
[[ -f "$AGENT_SKILLS_ROOT/manifest.sha256" \
  && ! -L "$AGENT_SKILLS_ROOT/manifest.sha256" \
  && "$(stat -c '%u:%g:%a' "$AGENT_SKILLS_ROOT/manifest.sha256")" \
    == "0:0:444" ]] \
  || smoke_fail "Agent Skills manifest 계약이 깨졌습니다."
if find "$AGENT_SKILLS_ROOT" -type l -print -quit | grep -q .; then
  smoke_fail "Agent Skills snapshot에 symlink가 포함되어 있습니다."
fi
if find "$AGENT_SKILLS_ROOT" ! -user root -print -quit | grep -q .; then
  smoke_fail "Agent Skills snapshot에 root 외 소유자가 있습니다."
fi
if find "$AGENT_SKILLS_ROOT" -type d ! -perm 0555 -print -quit | grep -q .; then
  smoke_fail "Agent Skills snapshot 디렉터리 mode가 0555가 아닙니다."
fi
if find "$AGENT_SKILLS_ROOT" -type f ! -perm 0444 -print -quit | grep -q .; then
  smoke_fail "Agent Skills snapshot 파일 mode가 0444가 아닙니다."
fi
agent_skills_count="$(
  find "$AGENT_SKILLS_ROOT/plugins/terraform/skills" \
    -mindepth 1 -maxdepth 1 -type d | wc -l
)"
agent_skills_count="${agent_skills_count//[[:space:]]/}"
[[ "$agent_skills_count" == 16 ]] \
  || smoke_fail "Terraform Agent Skill 수가 16개가 아닙니다."
for agent_skill in \
  refactor-module terraform-style-guide terraform-test; do
  [[ -f "$AGENT_SKILLS_ROOT/plugins/terraform/skills/${agent_skill}/SKILL.md" ]] \
    || smoke_fail "필수 Terraform Agent Skill이 없습니다: ${agent_skill}"
done
(cd "$AGENT_SKILLS_ROOT" && sha256sum -c manifest.sha256 >/dev/null) \
  || smoke_fail "Agent Skills snapshot checksum 검증에 실패했습니다."
manifest_inventory="$(
  sed -En 's|^[[:xdigit:]]{64}  [.]/||p' \
    "$AGENT_SKILLS_ROOT/manifest.sha256" | LC_ALL=C sort
)"
actual_snapshot_inventory="$(
  find "$AGENT_SKILLS_ROOT" -type f \
    ! -path "$AGENT_SKILLS_ROOT/manifest.sha256" \
    -printf '%P\n' | LC_ALL=C sort
)"
[[ "$manifest_inventory" == "$actual_snapshot_inventory" ]] \
  || smoke_fail "Agent Skills manifest 파일 목록이 snapshot과 정확히 일치하지 않습니다."

if [[ "$PUBLIC_SMOKE" == "true" ]]; then
  [[ -n "$LAB_HOST" ]] || smoke_fail "public smoke에는 LAB_HOST가 필요합니다."
  systemctl is-active --quiet caddy.service \
    || smoke_fail "Caddy service가 active가 아닙니다."
  public_health="$(curl -fsS --retry 30 --retry-delay 2 --retry-all-errors \
    --connect-timeout 5 --max-time 15 \
    --resolve "${LAB_HOST}:443:127.0.0.1" \
    "https://${LAB_HOST}/healthz")"
  jq -e --arg expected "$EXPECTED_COMMIT" '
    .ok == true and
    .runtimeKind == "terraform-native" and
    .courseId == "terraform-foundations" and
    ($expected == "" or .version == $expected)
  ' <<<"$public_health" >/dev/null \
    || smoke_fail "public HTTPS health 응답이 일치하지 않습니다."

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
  socket.once("open", () => { opened = true; });
  socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  socket.once("close", (code) => {
    clearTimeout(timer);
    if (!opened) return reject(new Error("WSS 연결이 열리기 전에 종료되었습니다."));
    if (code !== 4401) return reject(new Error(`인증 전 WSS 종료 코드: ${code}`));
    resolve();
  });
});
NODE
fi

if [[ "$PUBLIC_SMOKE" == "true" ]]; then
  echo "Terraform Lab local HTTP·public HTTPS·WSS smoke를 통과했습니다."
else
  echo "Terraform Lab local HTTP smoke를 통과했습니다."
fi
