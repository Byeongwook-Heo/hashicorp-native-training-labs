import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NativeVaultRuntime,
  isExactVerifierResult,
  slotLoopbackAddress,
} from "../server/native-runtime.js";

const workspace = process.cwd();

describe("native runtime security boundaries", () => {
  it("assigns one exact loopback /32 address to each valid slot", () => {
    expect(slotLoopbackAddress("s01")).toBe("127.77.0.1");
    expect(slotLoopbackAddress("s30")).toBe("127.77.0.30");
    expect(slotLoopbackAddress("s99")).toBe("127.77.0.99");
    for (const invalid of ["s00", "s100", "s1", "x01", "../s01"]) {
      expect(() => slotLoopbackAddress(invalid)).toThrow();
    }
  });

  it("accepts only a non-truncated exact structured verifier marker", () => {
    expect(
      isExactVerifierResult("enable-kv", {
        code: 0,
        stdout: "verified:enable-kv\n",
        truncated: false,
      }),
    ).toBe(true);
    for (const result of [
      { code: 1, stdout: "verified:enable-kv\n", truncated: false },
      { code: 0, stdout: "verified:enable-kv\n", truncated: true },
      { code: 0, stdout: "prefix verified:enable-kv\n", truncated: false },
      { code: 0, stdout: "verified:enable-kv\nsuffix\n", truncated: false },
      { code: 0, stdout: "verified:another-step\n", truncated: false },
    ]) {
      expect(isExactVerifierResult("enable-kv", result)).toBe(false);
    }
  });

  it("bounds the serialized native operation queue", async () => {
    const runtime = new NativeVaultRuntime({
      maxSessions: 1,
      maxQueuedOperations: 1,
    });
    const lock = (
      runtime as unknown as {
        withLock<T>(operation: () => Promise<T>): Promise<T>;
      }
    ).withLock.bind(runtime);
    let releaseGate!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const first = lock(async () => {
      signalStarted();
      await gate;
      return "done";
    });
    await started;

    await expect(lock(async () => "unexpected")).rejects.toMatchObject({
      code: "CAPACITY",
    });
    releaseGate();
    await expect(first).resolves.toBe("done");
  });

  it("keeps the student token role immutable and root-only bootstrapped", async () => {
    const source = await readFile(
      path.join(workspace, "server/native-runtime.ts"),
      "utf8",
    );
    expect(source).toContain('path "auth/token/create/app-read-role"');
    expect(source).not.toMatch(/path "auth\/token\/create"\s*\{/);
    expect(source).not.toContain('path "auth/token/roles/app-read-role"');
    expect(source).not.toContain('path "sys/policies/acl/app-read"');
    expect(source).not.toContain('path "sys/audit/*"');
    expect(source).toContain(
      'path "sys/audit" {\n  capabilities = ["read", "list", "sudo"]',
    );
    expect(source).toContain("private async configureSessionAudit");
    expect(source).toContain('file_path: "/tmp/vault-audit.log"');
    expect(source).toContain('mode: "0640"');
    expect(source).toContain('log_raw: "false"');
    expect(source).not.toContain('path "secret/*"');
    expect(source).toContain("const DEFAULT_MAX_SESSIONS = 4;");
    expect(source).toContain('allowed_policies: ["app-read"]');
    expect(source).toContain('disallowed_policies: ["root"]');
    expect(source).toContain("token_explicit_max_ttl: 1_800");
    expect(source).toContain('token_type: "service"');
  });

  it("uses a verifier UID and exact per-slot network drop-ins", async () => {
    const [control, service, execHelper, shellHelper, install, loopback, loopbackService] =
      await Promise.all([
      readFile(
        path.join(workspace, "infra/native/vault-lab-control"),
        "utf8",
      ),
      readFile(
        path.join(workspace, "infra/native/vault-lab@.service"),
        "utf8",
      ),
      readFile(
        path.join(workspace, "infra/native/vault-lab-exec"),
        "utf8",
      ),
      readFile(
        path.join(workspace, "infra/native/vault-lab-shell"),
        "utf8",
      ),
      readFile(path.join(workspace, "infra/native-install.sh"), "utf8"),
      readFile(
        path.join(workspace, "infra/native/vault-lab-loopback"),
        "utf8",
      ),
      readFile(
        path.join(workspace, "infra/native/vault-lab-loopback.service"),
        "utf8",
      ),
    ]);

    expect(service).toContain("IPAddressDeny=any");
    expect(service).not.toContain("IPAddressAllow=localhost");
    expect(control).toContain(
      "IPAddressAllow=${slot_address}/32",
    );
    expect(control).not.toContain('readonly slot="$2"');
    expect(control).toContain('readonly requested_slot="$2"');
    expect(install).toContain(
      'network_dropin="/etc/systemd/system/vault-lab@${slot}.service.d"',
    );
    expect(install).toContain(
      '"IPAddressAllow=${slot_address}/32"',
    );
    expect(control).toContain('"--uid=${verifier_user}"');
    expect(control).toContain(
      "--property=LoadCredential=vault-token:",
    );
    expect(install).toContain(
      "install -d -o root -g root -m 0711 /run/vault-lab",
    );
    expect(install).toContain(
      "install -d -o root -g root -m 0711 /run/vault-lab/slots",
    );
    expect(install).toContain(
      "install -d -o vault-lab -g vault-lab -m 0700 /run/vault-lab/app",
    );
    expect(install).toContain(
      "d /run/vault-lab 0711 root root -",
    );
    expect(install).toContain(
      "d /run/vault-lab/slots 0711 root root -",
    );
    expect(install).toContain(
      "d /run/vault-lab/app 0700 vault-lab vault-lab -",
    );
    expect(control).toContain(
      'install -d -o "$APP_USER" -g "$slot_user" -m 2750 "$runtime_dir"',
    );
    expect(execHelper).toContain(
      '[[ "$vault_address" == "127.77.0.${slot_number}" ]]',
    );
    expect(execHelper).toContain('[[ "$vault_port" == "820" ]]');
    expect(shellHelper).toContain('[[ "$vault_port" == "820" ]]');
    expect(install).toContain('verifier_user="vaultverify-${slot}"');
    expect(loopback).toContain(
      'ip address replace "${slot_address}/32" dev lo',
    );
    expect(loopback).toContain('grep -Eq "src ${slot_address}');
    expect(loopbackService).toContain(
      "CapabilityBoundingSet=CAP_NET_ADMIN",
    );
    expect(loopbackService).toContain("RestrictAddressFamilies=AF_NETLINK");
  });

  it("brokers only exact curriculum artifacts across distinct UIDs", async () => {
    const [control, service, installer, server, curriculum, smoke] =
      await Promise.all([
        readFile(
          path.join(workspace, "infra/native/vault-lab-control"),
          "utf8",
        ),
        readFile(
          path.join(workspace, "infra/native/vault-lab@.service"),
          "utf8",
        ),
        readFile(path.join(workspace, "infra/native-install.sh"), "utf8"),
        readFile(path.join(workspace, "server/index.ts"), "utf8"),
        readFile(path.join(workspace, "server/curriculum.ts"), "utf8"),
        readFile(
          path.join(workspace, "infra/smoke-native-runtime.sh"),
          "utf8",
        ),
      ]);
    const contract = control.slice(
      control.indexOf("artifact_contract()"),
      control.indexOf("handoff_artifact()"),
    );

    for (const artifact of [
      "app-read.hcl",
      "app-token.json",
      "token-audit.json",
      "role-id",
      "secret-id",
      "secret-id.json",
      "approle-login.json",
      "ciphertext",
      "decrypted.txt",
      "ciphertext-v2",
      "audit-trace.jsonl",
      "denied.out",
      "deny-proof.json",
      "revoked-token",
      "revoked-accessor",
      "revoked-proof.json",
      "api-cert.json",
    ]) {
      expect(contract, artifact).toContain(artifact);
    }
    for (const forbidden of [
      "root-token",
      "student-token",
      "vault-token",
      "pki-cert.",
      "pki-key.",
      "pki-ca.",
      "../",
    ]) {
      expect(contract, forbidden).not.toContain(forbidden);
    }
    expect(control).toContain("[[ -f \"$artifact_path\" && ! -L \"$artifact_path\" ]]");
    expect(control).toContain("source_uid}:${group_gid}:1:600");
    expect(control).toContain("chown --no-dereference");
    expect(control).toContain("MAX_ARTIFACT_BYTES=16777216");
    expect(control).toContain("systemctl freeze");
    expect(control).toContain("FreezerState");
    expect(control).toContain("vaultsvc-${slot}");
    expect(control).toContain("tmp 3770 root");
    expect(control).toContain("vault-audit.log");
    expect(control).toContain('-o "vaultsvc-${slot}"');
    expect(service).toContain("User=vaultsvc-%i");
    expect(service).toContain("CapabilityBoundingSet=CAP_NET_BIND_SERVICE");
    expect(service).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(installer).toContain("net.ipv4.ip_unprivileged_port_start = 1024");
    expect(installer).toContain('gpasswd -d vault-lab "$slot_user"');
    expect(curriculum).toContain('.options.mode == "0640"');
    expect(curriculum).toContain('.options.log_raw == "false"');
    expect(server).toContain('operation: "skip"');
    expect(server).toContain('operation: "verify"');
    expect(smoke).toContain("for (const step of steps)");
    expect(smoke).toContain('operation: "skip"');
    expect(smoke).toContain('operation: "verify"');
  });

  it("uses bounded mounted slot filesystems and cleans transient terminals", async () => {
    const [
      control,
      installer,
      runtime,
      service,
      smoke,
      reaper,
      reaperService,
    ] = await Promise.all([
      readFile(
        path.join(workspace, "infra/native/vault-lab-control"),
        "utf8",
      ),
      readFile(path.join(workspace, "infra/native-install.sh"), "utf8"),
      readFile(path.join(workspace, "server/native-runtime.ts"), "utf8"),
      readFile(
        path.join(workspace, "infra/native/vault-lab@.service"),
        "utf8",
      ),
      readFile(
        path.join(workspace, "infra/smoke-native-runtime.sh"),
        "utf8",
      ),
      readFile(
        path.join(workspace, "infra/native/vault-lab-reaper"),
        "utf8",
      ),
      readFile(
        path.join(workspace, "infra/native/vault-lab-reaper.service"),
        "utf8",
      ),
    ]);

    expect(installer).toContain("fallocate -l \"$SLOT_IMAGE_BYTES\"");
    expect(installer).toContain("mkfs.ext4");
    expect(installer).toContain("-N \"$SLOT_FILESYSTEM_INODES\"");
    expect(installer).toContain(
      "Options=loop,nodev,nosuid,noexec,noatime",
    );
    expect(installer).not.toMatch(/\nAfter=local-fs\.target\n/);
    expect(installer).toContain("vault-lab-storage.target");
    expect(smoke).toContain("df --output=itotal");
    expect(smoke).not.toContain("df -i --output");
    expect(control).toContain("findmnt -rn -M");
    expect(control).toContain(".vault-lab-slot");
    expect(control).not.toContain('rm -rf --one-file-system -- "$state_dir"');
    expect(service).toContain("Requires=vault-lab-storage.target");
    expect(runtime).toContain("const VAULT_API_PORT = 820;");
    expect(runtime).toContain('const NATIVE_CONTROL_ABI = "4";');
    expect(runtime).toContain("const METADATA_VERSION = 2;");
    expect(runtime).toContain("installedAbi !== NATIVE_CONTROL_ABI");
    expect(runtime).toContain(
      '`${record.generation}\\n`,',
    );
    expect(runtime).toContain("generation: createSessionId()");
    const publicSessionInfo = runtime.slice(
      runtime.indexOf("export interface NativeVaultSessionInfo"),
      runtime.indexOf("export interface NativeCommandOptions"),
    );
    expect(publicSessionInfo).not.toContain("generation");
    expect(runtime).toMatch(
      /"command",\s*session\.slot,\s*session\.generation,\s*options\.operation/,
    );
    expect(runtime).toMatch(
      /"terminal",\s*session\.slot,\s*session\.generation,\s*String\(remainingSeconds\)/,
    );
    expect(runtime).toContain(
      '"extend-guard",\n        record.slot,\n        record.generation,',
    );
    expect(runtime).toContain("value.port !== VAULT_API_PORT");
    expect(runtime).not.toContain("allocatePort(");
    expect(runtime).not.toContain("isPortAvailable(");
    expect(control).toContain("--property=SystemCallErrorNumber=EPERM");
    expect(control).toContain("stop_kind_units terminal");
    expect(control).toContain("trap cleanup_terminal_scope EXIT");
    expect(control).toContain("ActiveState --value");
    expect(control).toContain("require_session_binding");
    expect(control).toContain("session binding metadata is unsafe");
    expect(control).toContain("${app_uid}:${group_gid}:1:640:33");
    expect(control).toContain("write_expiry_guard");
    expect(control).toContain("require_runtime_directory()");
    expect(control).toContain(
      'temporary="$(mktemp "${CONTROL_STAGING_ROOT}/.${slot}.expires-at.XXXXXX")"',
    );
    expect(control).not.toContain(
      'temporary="$(mktemp "${runtime_dir}/.expires-at.XXXXXX")"',
    );
    expect(control).toContain(
      '"$(stat -c %d "$runtime_dir")" == "$(stat -c %d "$CONTROL_STAGING_ROOT")"',
    );
    expect(control).toContain('stat -c %m "$runtime_dir"');
    expect(control).toContain('stat -c %m "$CONTROL_STAGING_ROOT"');
    expect(control).toContain("src_dir_fd=source_directory");
    expect(control).toContain("dst_dir_fd=destination_directory");
    expect(control).toContain("/usr/bin/python3 -I -S -");
    expect(control).not.toContain("/usr/bin/python3 - \\");
    expect(control).not.toContain("mv -fT");
    expect(runtime).toContain(
      'path.dirname(this.options.runtimeRoot),\n      "app",\n      ".owner-lock"',
    );
    expect(smoke).toContain('stat("/run/vault-lab/app/.owner-lock")');
    expect(reaper).toContain(
      'exec {reaper_lock_fd}>"${control_lock_root}/reaper.lock"',
    );
    expect(reaper).toContain('flock -x "$reaper_lock_fd"');
    expect(reaper).toContain("umask 077");
    expect(reaperService).toContain(
      "ReadWritePaths=/run/vault-lab/slots " +
        "/run/lock/vault-lab-control /var/lib/vault-lab",
    );
    expect(reaperService).toContain("Requires=vault-lab-storage.target");
    expect(reaperService).toContain("After=vault-lab-storage.target");
    expect(reaperService).toContain("CAP_FSETID");
    expect(reaperService).not.toContain("RestrictSUIDSGID=yes");
    expect(installer).toContain("systemctl start vault-lab-reaper.service");
    expect(installer).toContain(
      "systemctl show -p Result --value vault-lab-reaper.service",
    );
    const runtimeAnchorCheck = installer.indexOf(
      "[[ -d /run/vault-lab && ! -L /run/vault-lab ]]",
    );
    const runtimeChildrenCleanup = installer.indexOf(
      "for runtime_child in /run/vault-lab/slots /run/vault-lab/app",
    );
    const runtimeSlotsInstall = installer.indexOf(
      "install -d -o root -g root -m 0711 /run/vault-lab/slots",
    );
    expect(runtimeAnchorCheck).toBeGreaterThan(-1);
    expect(runtimeChildrenCleanup).toBeGreaterThan(runtimeAnchorCheck);
    expect(runtimeSlotsInstall).toBeGreaterThan(runtimeChildrenCleanup);
    expect(smoke).toContain("systemctl start vault-lab-reaper.service");
    expect(smoke).toContain("reaper_expiry=");
    expect(smoke).toContain(':3770" ]]');
    expect(control).toContain("reap_slot");
    expect(control).toContain(
      'current_session="$(read_session_binding "$slot")"',
    );
    expect(smoke).toContain("staleGeneration");
    expect(smoke).toContain('["terminal", session.slot, staleGeneration, "1"]');
    expect(smoke).toContain(
      '["reap", session.slot, currentGeneration, String(previousExpiry)]',
    );
    const commandScope = control.slice(
      control.indexOf("run_command()"),
      control.indexOf("cleanup_terminal_scope()"),
    );
    expect(commandScope.indexOf('acquire_slot_lock "$slot"')).toBeLessThan(
      commandScope.indexOf('require_session_binding "$slot" "$expected_session"'),
    );
    expect(
      commandScope.indexOf('require_session_binding "$slot" "$expected_session"'),
    ).toBeLessThan(commandScope.indexOf("systemd-run"));
    const terminalScope = control.slice(
      control.indexOf("run_terminal()"),
      control.indexOf("terminal_count()"),
    );
    expect(terminalScope.indexOf('acquire_slot_lock "$slot"')).toBeLessThan(
      terminalScope.indexOf('require_session_binding "$slot" "$expected_session"'),
    );
    expect(
      terminalScope.indexOf('require_session_binding "$slot" "$expected_session"'),
    ).toBeLessThan(terminalScope.indexOf("systemd-run"));
    expect(terminalScope).toContain("exec {terminal_input_fd}<&0");
    expect(terminalScope).toContain('<&"$terminal_input_fd" &');
    expect(terminalScope.indexOf("exec {terminal_input_fd}<&0")).toBeLessThan(
      terminalScope.indexOf("systemd-run"),
    );
    expect(terminalScope.indexOf('SCOPE_RUNNER_PID=$!')).toBeLessThan(
      terminalScope.indexOf("exec {terminal_input_fd}<&-"),
    );
    expect(smoke).toContain("fallocate -l ${byteLimit}");
    expect(smoke).toContain(".vault-lab-inode-boundary");
    expect(smoke).toContain("learner-port-probe");
    expect(smoke).toContain("learner-signal-probe");
    expect(control).toContain("probe_learner_signal()");
    expect(control).toContain("except PermissionError:");
    expect(control).not.toContain("/usr/bin/node-22 --input-type=module");
    expect(installer).toMatch(/\n  python3 \\\n/);
    expect(smoke).toContain("terminal-capeff-0000000000000000");
    expect(smoke).toContain("terminal-count");
    expect(smoke).toContain("const waitForTerminalReady");
    expect(smoke).toContain("\\u001b[35mvault-lab\\u001b[0m");
    expect(smoke.match(/await waitForTerminalReady\(terminal\);/g)).toHaveLength(2);
    expect(smoke).toContain("raw-file");
    expect(smoke).toContain("raw-socket");
    expect(smoke).toContain("permission denied|Code:[[:space:]]*403");
    expect(smoke).toContain("raw-audit-unexpected");
    expect(smoke).toContain("socket-audit-unexpected");
    expect(smoke).toContain('grep -F -- "$VAULT_TOKEN"');
  });

  it("installs Node.js 22 only from the application installer", async () => {
    const [nativeInstall, userData, applicationInstall] = await Promise.all([
      readFile(path.join(workspace, "infra/native-install.sh"), "utf8"),
      readFile(path.join(workspace, "infra/ec2-user-data.sh"), "utf8"),
      readFile(path.join(workspace, "infra/install-application.sh"), "utf8"),
    ]);

    expect(nativeInstall).not.toMatch(/^\s+(?:nodejs|npm)\s*\\?$/m);
    expect(nativeInstall).not.toContain("nodejs22");
    expect(nativeInstall).not.toContain("nodejs22-npm");
    expect(userData).not.toContain("nodejs22");
    expect(userData).not.toContain("nodejs22-npm");
    expect(applicationInstall).toMatch(
      /^dnf install -y nodejs22 nodejs22-npm$/m,
    );
  });

  it("disables the Caddy admin API and binds Node to loopback by default", async () => {
    const [caddy, server] = await Promise.all([
      readFile(path.join(workspace, "Caddyfile"), "utf8"),
      readFile(path.join(workspace, "server/index.ts"), "utf8"),
    ]);
    expect(caddy).toMatch(/\{\s*admin off\s*\}/);
    expect(caddy).not.toContain("52-79-170-130.sslip.io");
    expect(server).toContain(
      'const HOST = process.env.HOST || "127.0.0.1";',
    );
    expect(server).toContain("server.listen(PORT, HOST");
    expect(server).not.toContain('server.listen(PORT, "0.0.0.0"');
    expect(server).toContain("skipSetup: _skipSetup");
    expect(server).toContain("isExactVerifierResult(step.id, result)");
    expect(server.indexOf("runtime.execute(id, step.skipSetup)")).toBeLessThan(
      server.indexOf("auth.recordSkip("),
    );
  });
});
