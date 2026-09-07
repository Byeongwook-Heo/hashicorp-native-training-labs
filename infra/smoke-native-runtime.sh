#!/usr/bin/env bash
set -euo pipefail

umask 0077

RELEASE_DIR="$(readlink -f "${1:-/opt/vault-lab/current}")"
readonly RELEASE_DIR
readonly NODE_BIN="/usr/bin/node-22"
readonly FILESYSTEM_ENV="/etc/vault-lab/slot-filesystem.env"

if (( EUID != 0 )); then
  echo "smoke-native-runtime.sh는 root로 실행해야 합니다." >&2
  exit 1
fi
if [[ ! -r "${RELEASE_DIR}/dist-server/native-runtime.js" \
  || ! -r "${RELEASE_DIR}/dist-server/curriculum.js" ]]; then
  echo "${RELEASE_DIR}에 빌드된 native runtime/curriculum이 없습니다." >&2
  exit 1
fi
if systemctl is-active --quiet vault-lab-web.service; then
  echo "슬롯 소유권 충돌을 피하려면 web 서비스를 중지한 상태에서 실행하세요." >&2
  exit 1
fi
if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node.js 22 실행 파일을 찾을 수 없습니다: ${NODE_BIN}" >&2
  exit 1
fi
if [[ ! -r "$FILESYSTEM_ENV" ]]; then
  echo "슬롯 파일시스템 경계 설정을 찾을 수 없습니다." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$FILESYSTEM_ENV"
[[ "${SLOT_IMAGE_BYTES:-}" =~ ^[0-9]+$ \
  && "${SLOT_FILESYSTEM_INODES:-}" =~ ^[0-9]+$ ]] || {
  echo "슬롯 파일시스템 경계 설정이 올바르지 않습니다." >&2
  exit 1
}
[[ "$(sysctl -n net.ipv4.ip_unprivileged_port_start)" == "1024" ]] || {
  echo "low-port endpoint 경계가 적용되지 않았습니다." >&2
  exit 1
}

mount_data="$(
  findmnt -rn -M /var/lib/vault-lab/sessions/s01 -o TARGET,FSTYPE,OPTIONS
)"
[[ "$mount_data" == "/var/lib/vault-lab/sessions/s01 ext4 "* ]] || {
  echo "s01 bounded ext4가 마운트되지 않았습니다." >&2
  exit 1
}
for required_option in rw nodev nosuid noexec; do
  [[ ",${mount_data#* ext4 }," == *",${required_option},"* ]] || {
    echo "s01 bounded ext4에 ${required_option}가 없습니다." >&2
    exit 1
  }
done
[[ "$(df --output=itotal /var/lib/vault-lab/sessions/s01 | awk 'NR == 2 { print $1 }')" \
    == "$SLOT_FILESYSTEM_INODES" ]] || {
  echo "s01 inode 경계가 설정과 다릅니다." >&2
  exit 1
}

sudo -u vault-lab \
  env \
    HOME=/var/lib/vault-lab/app \
    MAX_SESSIONS=1 \
    SESSION_TTL_HOURS=1 \
    RELEASE_DIR="$RELEASE_DIR" \
    SLOT_IMAGE_BYTES="$SLOT_IMAGE_BYTES" \
    SLOT_FILESYSTEM_INODES="$SLOT_FILESYSTEM_INODES" \
  timeout 360 "$NODE_BIN" --input-type=module <<'NODE'
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeUrl = pathToFileURL(
  path.join(process.env.RELEASE_DIR, "dist-server/native-runtime.js")
).href;
const curriculumUrl = pathToFileURL(
  path.join(process.env.RELEASE_DIR, "dist-server/curriculum.js")
).href;
const {
  NativeVaultRuntime,
  createSessionId,
  isExactVerifierResult
} = await import(runtimeUrl);
const { steps } = await import(curriculumUrl);
const controlBinary = "/usr/local/sbin/vault-lab-control";
const runtime = new NativeVaultRuntime({
  maxSessions: 1,
  sessionTtlMs: 10 * 60 * 1_000
});
const sessionId = createSessionId();
let terminal;

const control = (args, expectedSuccess = true) => {
  const result = spawnSync("sudo", ["-n", controlBinary, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8"
    },
    timeout: 30_000
  });
  const succeeded = result.status === 0 && !result.error;
  if (succeeded !== expectedSuccess) {
    throw new Error(
      `control ${args[0]}의 결과가 예상과 다릅니다: ${result.stderr || result.error || result.status}`
    );
  }
  return result;
};

const waitForTerminalCount = async (slot, expected) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = control(["terminal-count", slot]);
    if (Number(result.stdout.trim()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`terminal unit 수가 ${expected}(으)로 수렴하지 않았습니다.`);
};

const waitForTerminalReady = (channel, timeoutMs = 10_000) =>
  new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.output.off("data", onData);
      channel.errorOutput.off("data", onData);
      if (error) reject(error);
      else resolve();
    };
    const onData = (data) => {
      output += data.toString("utf8");
      if (
        output.includes("Vault Native Lab")
        && output.includes("VAULT_ADDR=http://127.77.0.1:820")
        && output.includes("\u001b[35mvault-lab\u001b[0m")
      ) {
        finish();
      }
    };
    channel.output.on("data", onData);
    channel.errorOutput.on("data", onData);
    timer = setTimeout(
      () => finish(new Error("terminal readiness 시간이 초과되었습니다.")),
      timeoutMs
    );
    void channel.exited.then(() => {
      finish(new Error("terminal이 readiness 전에 종료되었습니다."));
    });
  });

const collectTerminal = async (channel, commands, timeoutMs = 30_000) => {
  let output = "";
  channel.output.on("data", (data) => {
    output += data.toString("utf8");
  });
  channel.errorOutput.on("data", (data) => {
    output += data.toString("utf8");
  });
  for (const command of commands) channel.write(`${command}\n`);
  let timeoutId;
  const terminalTimeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("terminal smoke 시간이 초과되었습니다.")),
      timeoutMs
    );
  });
  await Promise.race([channel.exited, terminalTimeout]);
  clearTimeout(timeoutId);
  return output;
};

try {
  await runtime.initialize();
  let session = await runtime.getOrCreate(sessionId);
  if (session.slot !== "s01") {
    throw new Error(`예상하지 못한 smoke 슬롯: ${session.slot}`);
  }
  if (session.address !== "http://127.77.0.1:820") {
    throw new Error(`고정 privileged endpoint가 아닙니다: ${session.address}`);
  }
  if (Object.prototype.hasOwnProperty.call(session, "generation")) {
    throw new Error("internal session generation이 public session info에 노출되었습니다.");
  }
  const runtimeDirectory = `/run/vault-lab/slots/${session.slot}`;
  const bindingPath = `${runtimeDirectory}/session-id`;
  const [
    runtimeParentStat,
    runtimeRootStat,
    controlStagingStat,
    appRuntimeStat,
    ownerLockStat
  ] =
    await Promise.all([
      stat("/run/vault-lab"),
      stat("/run/vault-lab/slots"),
      stat("/run/vault-lab/slots/.control"),
      stat("/run/vault-lab/app"),
      stat("/run/vault-lab/app/.owner-lock")
    ]);
  if (
    runtimeParentStat.uid !== 0
    || runtimeParentStat.gid !== 0
    || (runtimeParentStat.mode & 0o777) !== 0o711
    || runtimeRootStat.uid !== 0
    || runtimeRootStat.gid !== 0
    || (runtimeRootStat.mode & 0o777) !== 0o711
    || controlStagingStat.uid !== 0
    || controlStagingStat.gid !== 0
    || (controlStagingStat.mode & 0o777) !== 0o700
    || appRuntimeStat.uid !== process.getuid()
    || appRuntimeStat.gid !== process.getgid()
    || (appRuntimeStat.mode & 0o777) !== 0o700
    || ownerLockStat.uid !== process.getuid()
    || ownerLockStat.gid !== process.getgid()
    || (ownerLockStat.mode & 0o777) !== 0o700
  ) {
    throw new Error("runtime root anchor 또는 app owner lock 경계가 안전하지 않습니다.");
  }
  for (const rootAnchor of ["/run/vault-lab", "/run/vault-lab/slots"]) {
    const writable = await access(rootAnchor, constants.W_OK)
      .then(() => true)
      .catch((error) => {
        if (error?.code === "EACCES" || error?.code === "EPERM") return false;
        throw error;
      });
    if (writable) {
      throw new Error(`application user가 runtime root anchor를 쓸 수 있습니다: ${rootAnchor}`);
    }
  }
  await access("/run/vault-lab/app", constants.W_OK);
  const staleGeneration = (await readFile(bindingPath, "utf8")).trim();
  if (!/^[a-f0-9]{32}$/.test(staleGeneration)) {
    throw new Error("초기 session generation binding이 올바르지 않습니다.");
  }
  const reusedSlot = session.slot;
  session = await runtime.reset(sessionId);
  if (session.slot !== reusedSlot) {
    throw new Error("single-slot smoke에서 reset 후 같은 slot이 재할당되지 않았습니다.");
  }

  const [binding, bindingStat, runtimeStat] = await Promise.all([
    readFile(bindingPath, "utf8"),
    stat(bindingPath),
    stat(runtimeDirectory)
  ]);
  const currentGeneration = binding.trim();
  if (
    !/^[a-f0-9]{32}\n$/.test(binding)
    || currentGeneration === staleGeneration
    || bindingStat.uid !== process.getuid()
    || bindingStat.gid !== runtimeStat.gid
    || bindingStat.nlink !== 1
    || (bindingStat.mode & 0o777) !== 0o640
  ) {
    throw new Error("session-id commit 파일의 내용 또는 메타데이터가 안전하지 않습니다.");
  }

  control(
    ["command", session.slot, staleGeneration, "verify", "status", "--", "/bin/true"],
    false
  );
  control(["terminal", session.slot, staleGeneration, "1"], false);

  const previousExpiry = session.expiresAt;
  session = await runtime.extend(sessionId, 60_000);
  control(["reap", session.slot, currentGeneration, String(previousExpiry)]);
  const afterStaleReap = await runtime.get(sessionId);
  if (!afterStaleReap || afterStaleReap.expiresAt !== session.expiresAt) {
    throw new Error("stale reaper 요청이 연장된 현재 세션을 제거했습니다.");
  }

  for (const step of steps) {
    const setup = await runtime.execute(sessionId, step.skipSetup, {
      operation: "skip",
      stepId: step.id
    });
    if (setup.code !== 0 || setup.truncated) {
      throw new Error(`${step.id} skip fixture가 실패했습니다.`);
    }
    const validation = await runtime.execute(sessionId, step.validate, {
      operation: "verify",
      stepId: step.id
    });
    if (!isExactVerifierResult(step.id, validation)) {
      throw new Error(`${step.id} verifier가 exact marker를 반환하지 않았습니다.`);
    }
  }

  const rawTokenCheck = await runtime.execute(
    sessionId,
    [
      "/bin/sh",
      "-c",
      `set -eu
if grep -F -- "$VAULT_TOKEN" /tmp/vault-audit.log >/dev/null; then
  exit 1
fi
printf '%s\\n' 'verified:audit-inspect'
`
    ],
    { operation: "verify", stepId: "audit-inspect" }
  );
  if (!isExactVerifierResult("audit-inspect", rawTokenCheck)) {
    throw new Error("audit log에 verifier root token 원문이 포함되었습니다.");
  }

  const byteLimit = Number(process.env.SLOT_IMAGE_BYTES);
  const inodeLimit = Number(process.env.SLOT_FILESYSTEM_INODES);
  const boundaryScript = `
set -eu
rm -f /tmp/.vault-lab-byte-boundary
if fallocate -l ${byteLimit} /tmp/.vault-lab-byte-boundary 2>/dev/null; then
  rm -f /tmp/.vault-lab-byte-boundary
  exit 1
fi
rm -f /tmp/.vault-lab-byte-boundary
rm -rf /tmp/.vault-lab-inode-boundary
mkdir /tmp/.vault-lab-inode-boundary
created=0
while touch "/tmp/.vault-lab-inode-boundary/f$created" 2>/dev/null; do
  created=$((created + 1))
  if [ "$created" -gt ${inodeLimit} ]; then
    rm -rf /tmp/.vault-lab-inode-boundary
    exit 1
  fi
done
test "$created" -gt 0
rm -rf /tmp/.vault-lab-inode-boundary
printf '%s\\n' 'verified:status'
`;
  const boundary = await runtime.execute(
    sessionId,
    ["/bin/sh", "-c", boundaryScript],
    { operation: "verify", stepId: "status", timeoutMs: 30_000 }
  );
  if (!isExactVerifierResult("status", boundary)) {
    throw new Error("slot byte/inode 경계 smoke가 실패했습니다.");
  }

  const pidResult = control(["service-pid", session.slot]);
  const vaultPid = Number(pidResult.stdout.trim());
  control(["learner-signal-probe", session.slot]);
  const learnerUidResult = spawnSync(
    "/usr/bin/id",
    ["-u", `vaultlab-${session.slot}`],
    { encoding: "utf8" }
  );
  const learnerUid = Number(learnerUidResult.stdout.trim());
  if (
    learnerUidResult.status !== 0
    || !Number.isSafeInteger(learnerUid)
    || learnerUid <= 0
  ) {
    throw new Error("learner UID를 확인하지 못했습니다.");
  }
  terminal = await runtime.openTerminal(sessionId);
  await waitForTerminalReady(terminal);
  const terminalOutput = await collectTerminal(terminal, [
    "printf 'terminal-euid-%s\\n' \"$(id -u)\"",
    "awk '/^CapEff:/ { printf \"terminal-capeff-%s\\\\n\", $2 }' /proc/self/status",
    "if vault audit enable -path=raw-file file file_path=/tmp/raw-audit.log log_raw=true >/tmp/raw-audit-denied.out 2>&1; then printf '%s%s\\n' raw-audit- unsafe; elif grep -Eiq 'permission denied|Code:[[:space:]]*403' /tmp/raw-audit-denied.out; then printf '%s%s\\n' raw-audit- denied; else printf '%s%s\\n' raw-audit- unexpected; fi",
    "if vault audit enable -path=raw-socket socket address=127.77.0.1:19000 socket_type=tcp log_raw=true >/tmp/socket-audit-denied.out 2>&1; then printf '%s%s\\n' socket-audit- unsafe; elif grep -Eiq 'permission denied|Code:[[:space:]]*403' /tmp/socket-audit-denied.out; then printf '%s%s\\n' socket-audit- denied; else printf '%s%s\\n' socket-audit- unexpected; fi",
    "vault token lookup -format=json",
    "vault status -format=json",
    "exit"
  ]);
  terminal = undefined;
  const terminalIdentityMarkers =
    terminalOutput.match(/terminal-(?:euid-[0-9]+|capeff-[a-fA-F0-9]+)/g) ?? [];
  if (
    !terminalOutput.includes(`terminal-euid-${learnerUid}`)
    || !terminalOutput.includes("terminal-capeff-0000000000000000")
  ) {
    throw new Error(
      `웹 터미널 learner UID 또는 capability 경계가 올바르지 않습니다: ${
        terminalIdentityMarkers.join(",") || "identity-marker-missing"
      }`
    );
  }
  if (
    !terminalOutput.includes("raw-audit-denied")
    || !terminalOutput.includes("socket-audit-denied")
    || terminalOutput.includes("raw-audit-unsafe")
    || terminalOutput.includes("socket-audit-unsafe")
    || terminalOutput.includes("raw-audit-unexpected")
    || terminalOutput.includes("socket-audit-unexpected")
  ) {
    throw new Error("learner raw file/socket audit 거부가 Vault ACL 403으로 확인되지 않았습니다.");
  }
  if (!terminalOutput.includes("lab-student")) {
    throw new Error("웹 터미널에 제한된 lab-student 토큰이 전달되지 않았습니다.");
  }
  if (!/"sealed"\s*:\s*false/.test(terminalOutput)) {
    throw new Error("웹 터미널에서 Vault 상태를 확인하지 못했습니다.");
  }
  if (Number(control(["service-pid", session.slot]).stdout.trim()) !== vaultPid) {
    throw new Error("learner signal smoke 중 Vault daemon PID가 변경되었습니다.");
  }

  terminal = await runtime.openTerminal(sessionId);
  await waitForTerminalReady(terminal);
  terminal.write("while :; do :; done >/dev/null 2>&1\n");
  await new Promise((resolve) => setTimeout(resolve, 500));
  terminal.kill();
  let orphanTimer;
  await Promise.race([
    terminal.exited,
    new Promise((_, reject) => {
      orphanTimer = setTimeout(
        () => reject(new Error("terminal disconnect cleanup 시간이 초과되었습니다.")),
        10_000
      );
    })
  ]);
  clearTimeout(orphanTimer);
  terminal = undefined;
  await waitForTerminalCount(session.slot, 0);

  control(["stop", session.slot]);
  control(["learner-port-probe", session.slot]);
  control(
    [
      "command",
      session.slot,
      currentGeneration,
      "verify",
      "status",
      "--",
      "/usr/local/bin/vault",
      "status",
      "-format=json"
    ],
    false
  );

  session = await runtime.reset(sessionId);
  if (session.address !== "http://127.77.0.1:820") {
    throw new Error("reset 후 privileged endpoint 계약이 바뀌었습니다.");
  }
  await runtime.destroy(sessionId);
} finally {
  terminal?.kill();
  await runtime.destroy(sessionId).catch(() => undefined);
  await runtime.close();
}
NODE

reaper_smoke_slot="s01"
reaper_runtime_dir="/run/vault-lab/slots/${reaper_smoke_slot}"
reaper_generation="$(
  tr -d '-' </proc/sys/kernel/random/uuid | cut -c 1-32
)"
reaper_expiry="$(( $(date +%s) * 1000 - 60000 ))"
/usr/local/sbin/vault-lab-control prepare "$reaper_smoke_slot"
[[ ! -e "${reaper_runtime_dir}/session-id" \
  && ! -L "${reaper_runtime_dir}/session-id" \
  && ! -e "${reaper_runtime_dir}/expires-at" \
  && ! -L "${reaper_runtime_dir}/expires-at" ]]
printf '%s\n' "$reaper_generation" >"${reaper_runtime_dir}/session-id"
printf '%s\n' "$reaper_expiry" >"${reaper_runtime_dir}/expires-at"
chown \
  "vault-lab:vaultlab-${reaper_smoke_slot}" \
  "${reaper_runtime_dir}/session-id" \
  "${reaper_runtime_dir}/expires-at"
chmod 0640 \
  "${reaper_runtime_dir}/session-id" \
  "${reaper_runtime_dir}/expires-at"
systemctl start vault-lab-reaper.service
[[ "$(systemctl show -p Result --value vault-lab-reaper.service)" == "success" ]]
[[ ! -e "${reaper_runtime_dir}/session-id" \
  && ! -L "${reaper_runtime_dir}/session-id" \
  && ! -e "${reaper_runtime_dir}/expires-at" \
  && ! -L "${reaper_runtime_dir}/expires-at" ]]
[[ "$(stat -c '%u:%g:%a' "$reaper_runtime_dir")" \
  == "$(id -u vault-lab):$(getent group "vaultlab-${reaper_smoke_slot}" | cut -d: -f3):2750" ]]
[[ "$(stat -c '%u:%g:%a' "/var/lib/vault-lab/sessions/${reaper_smoke_slot}/tmp")" \
  == "0:$(getent group "vaultlab-${reaper_smoke_slot}" | cut -d: -f3):3770" ]]

echo "Native Vault 30단계·skip·artifact·filesystem·endpoint·terminal·reaper smoke를 통과했습니다."
