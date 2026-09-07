import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspace = process.cwd();
const read = (relative: string) => readFile(path.join(workspace, relative), "utf8");

const expectedStepIds = [
  "tf-version",
  "local-init",
  "saved-plan",
  "apply-local",
  "typed-inputs",
  "auto-tfvars",
  "local-render",
  "sensitive-random",
  "safe-output",
  "state-inspect",
  "drift-detect",
  "drift-reconcile",
  "backup-destroy",
  "foreach-files",
  "count-random",
  "explicit-dependency",
  "graph-export",
  "module-contract",
  "module-call",
  "module-output",
  "terraform-test",
  "moved-refactor",
  "tls-keypair",
  "sensitive-state-audit",
  "conditions-checks",
  "lock-integrity",
  "workspace-stage",
  "replace-release",
  "refresh-only",
  "safe-destroy",
  "agent-skills-catalog",
  "agent-skills-select",
  "agent-skills-install",
  "agent-skills-guided-test",
] as const;

describe("native Terraform runtime security contracts", () => {
  it("pins Terraform and an offline root-owned provider mirror", async () => {
    const [installer, shell, executor] = await Promise.all([
      read("infra/terraform-native-install.sh"),
      read("infra/terraform-native/terraform-lab-shell"),
      read("infra/terraform-native/terraform-lab-exec"),
    ]);

    expect(installer).toContain("readonly TERRAFORM_VERSION=1.15.8");
    for (const provider of [
      "local:2.5.3",
      "random:3.7.2",
      "null:3.2.4",
      "tls:4.1.0",
    ]) {
      expect(installer).toContain(`'${provider}'`);
    }
    expect(installer).toContain("https://releases.hashicorp.com/");
    expect(installer).toContain("sha256sum -c -");
    expect(installer).toContain("HASHICORP_RELEASE_KEY_SHA256=");
    expect(installer).toContain("gnupg2-minimal");
    expect(installer).toContain("dnf swap -y gnupg2-minimal gnupg2-full");
    expect(installer).toContain("command -v gpg-agent");
    expect(installer).not.toMatch(/^\s+gnupg2 \\/m);
    expect(installer).toContain("command -v gpg");
    expect(installer).toContain("_SHA256SUMS.sig");
    expect(installer).toContain('--verify "$signature_path" "$sums_path"');
    expect(installer).toContain("unzip -Z1");
    expect(installer).toContain("provider_entry_count");
    expect(installer).toContain("provider-manifest.sha256");
    expect(installer).toContain("filesystem_mirror");
    expect(installer).not.toMatch(/^\s*direct\s*\{/m);
    expect(installer).toContain("disable_checkpoint = true");
    expect(installer).toContain("[[ -L \"$installed_path\" ]]");
    expect(installer).toContain("plan -input=false -lock=false");
    expect(installer).toContain("show -json smoke.tfplan");
    for (const environmentScript of [shell, executor]) {
      expect(environmentScript).toContain(
        "TF_CLI_CONFIG_FILE=/etc/terraform-lab/terraform.rc",
      );
      expect(environmentScript).toContain("CHECKPOINT_DISABLE=1");
      expect(environmentScript).toContain("AWS_EC2_METADATA_DISABLED=true");
      expect(environmentScript).toContain("TF_INPUT=0");
      expect(environmentScript).toContain("unset AWS_ACCESS_KEY_ID");
    }
  });

  it("creates fixed one-GiB noexec slot filesystems without Docker", async () => {
    const installer = await read("infra/terraform-native-install.sh");
    expect(installer).toContain("readonly SLOT_FILESYSTEM_MIB=1024");
    expect(installer).toContain("readonly SLOT_FILESYSTEM_INODES=16384");
    expect(installer).toContain("Options=loop,nodev,nosuid,noexec");
    expect(installer).toContain("fallocate -l \"$SLOT_IMAGE_BYTES\"");
    expect(installer).toContain("mkfs.ext4");
    expect(installer).toContain("tflab-${slot}");
    expect(installer).toContain("Docker/containerd is not permitted");
    expect(installer).not.toMatch(/\bdocker\s+(run|build|pull)\b/);
  });

  it("pins a root-owned offline HashiCorp Agent Skills snapshot", async () => {
    const [installer, control, smoke, abi, runtime] = await Promise.all([
      read("infra/terraform-native-install.sh"),
      read("infra/terraform-native/terraform-lab-control"),
      read("infra/terraform-smoke-deployment.sh"),
      read("infra/terraform-native/CONTROL_ABI"),
      read("server/terraform-runtime.ts"),
    ]);

    const commit = "4451ceca5456e79cc776efee96a744f7ac96e5bf";
    expect(installer).toContain(`readonly AGENT_SKILLS_COMMIT=${commit}`);
    expect(installer).toContain("https://github.com/hashicorp/agent-skills.git");
    expect(installer).toContain('fetch --quiet --depth=1 origin "$AGENT_SKILLS_COMMIT"');
    expect(installer).toContain('rev-parse HEAD');
    expect(installer).toContain("readonly AGENT_SKILLS_COUNT=16");
    expect(installer).toContain("lifecycle-status: active");
    expect(installer).toContain("Mozilla Public License Version 2.0");
    expect(installer).toContain("SUPPORTED_MODELS.md");
    expect(installer).toContain("SECURITY.md SUPPORT.md LICENSE");
    expect(installer).toContain("Agent Skills metadata가 안전하지 않습니다");
    expect(installer).toContain("manifest.sha256");
    expect(installer).toContain("! -path './manifest.sha256'");
    expect(installer).toContain("find \"$agent_skills_candidate\" -type d -exec chmod 0555");
    expect(installer).toContain("find \"$agent_skills_candidate\" -type f -exec chmod 0444");
    expect(control).toContain("readonly AGENT_SKILLS_ROOT=/opt/terraform-lab/agent-skills");
    expect(control).toContain("${AGENT_SKILLS_ROOT}");
    expect(control).toContain("--property=IPAddressDeny=any");
    expect(smoke).toContain(`readonly AGENT_SKILLS_COMMIT=\"${commit}\"`);
    expect(smoke).toContain("Agent Skills snapshot checksum");
    expect(smoke).toContain("-type d ! -perm 0555");
    expect(smoke).toContain("-type f ! -perm 0444");
    expect(smoke).toContain("actual_snapshot_inventory");
    expect(smoke).toContain('! -path "$AGENT_SKILLS_ROOT/manifest.sha256"');
    expect(abi.trim()).toBe("2");
    expect(runtime).toContain('const NATIVE_CONTROL_ABI = "2";');
  });

  it("recreates and verifies every strict slot runtime directory after reboot", async () => {
    const [installer, runtime, control, smoke] = await Promise.all([
      read("infra/terraform-native-install.sh"),
      read("server/terraform-runtime.ts"),
      read("infra/terraform-native/terraform-lab-control"),
      read("infra/terraform-smoke-deployment.sh"),
    ]);

    expect(installer).toContain(
      "readonly TMPFILES_CONFIG=/etc/tmpfiles.d/terraform-lab.conf",
    );
    expect(installer).toContain(
      "d /run/terraform-lab/slots/%s 2750 terraform-lab tflab-%s -\\n",
    );
    expect(installer).toContain('>>"$TMPFILES_CONFIG"');
    expect(installer).toContain('systemd-tmpfiles --create "$TMPFILES_CONFIG"');
    expect(installer.indexOf("useradd --system --user-group")).toBeLessThan(
      installer.indexOf('cat >"$TMPFILES_CONFIG"'),
    );
    expect(installer.indexOf('cat >"$TMPFILES_CONFIG"')).toBeLessThan(
      installer.indexOf('systemd-tmpfiles --create "$TMPFILES_CONFIG"'),
    );

    expect(runtime).toContain('if (!record) {');
    expect(runtime).toContain('await this.control(["prepare", slot]);');
    expect(runtime).not.toContain("hasCommitMarker");
    expect(control).toContain(
      '"$(stat -c \'%u:%g:%a\' "$runtime_dir")" == "${app_uid}:${slot_gid}:2750"',
    );
    const prepareStart = control.indexOf("prepare_slot_locked()");
    const runtimeCheck = control.indexOf(
      'require_runtime_directory "$slot"',
      prepareStart,
    );
    const workspaceReset = control.indexOf(
      'reset_directory "$slot" home',
      prepareStart,
    );
    expect(runtimeCheck).toBeGreaterThan(prepareStart);
    expect(workspaceReset).toBeGreaterThan(runtimeCheck);
    expect(smoke).toContain('native_slot_count="$(read_env_value MAX_SESSIONS)"');
    expect(smoke).toContain(
      '"d ${runtime_dir} 2750 terraform-lab tflab-${slot} -"',
    );
    expect(smoke).toContain(
      '== "${app_uid}:${slot_gid}:2750"',
    );
  });

  it("freezes terminals and validates generation before trusted argv", async () => {
    const control = await read(
      "infra/terraform-native/terraform-lab-control",
    );
    const allowlistBody = control
      .split('case "${1:-}" in')[1]
      ?.split(")", 1)[0];
    expect(allowlistBody).toBeTruthy();
    const allowedStepIds = allowlistBody!
      .replace(/\\\n/g, "")
      .split("|")
      .map((stepId) => stepId.trim())
      .filter(Boolean);
    expect(allowedStepIds).toEqual(expectedStepIds);
    expect(new Set(expectedStepIds).size).toBe(34);
    expect(control).toContain('[[ "$operation" == verify || "$operation" == skip ]]');
    expect(control).toContain("require_root_owned_executable \"$1\"");
    expect(control).toContain("curriculum executable is not root-owned");
    expect(control).toContain("require_binding \"$slot\" \"$generation\"");
    expect(control).toContain("freeze_terminals \"$slot\"");
    expect(control).toContain("systemctl freeze");
    expect(control).toContain("systemctl thaw");
    expect(control).toContain('"--uid=${slot_user}" "--gid=${slot_user}"');
    expect(control).toContain("escaped_argv+=(");
    expect(control).toContain(String.raw`argument//\$/\$\$`);
    expect(control).toContain(
      '/usr/local/libexec/terraform-lab-exec "$slot" "${escaped_argv[@]}"',
    );

    const commandStart = control.indexOf("run_command()");
    const executableCheck = control.indexOf(
      'require_root_owned_executable "$1"',
      commandStart,
    );
    const argvEscape = control.indexOf("escaped_argv+=(", commandStart);
    const binding = control.indexOf(
      'require_binding "$slot" "$generation"',
      commandStart,
    );
    const freeze = control.indexOf(
      'freeze_terminals "$slot"',
      commandStart,
    );
    const launch = control.indexOf("systemd-run", commandStart);
    expect(executableCheck).toBeGreaterThan(commandStart);
    expect(argvEscape).toBeGreaterThan(executableCheck);
    expect(argvEscape).toBeLessThan(launch);
    expect(binding).toBeGreaterThan(-1);
    expect(freeze).toBeGreaterThan(binding);
    expect(launch).toBeGreaterThan(freeze);
  });

  it("bounds command and terminal scopes with no network or host writes", async () => {
    const control = await read(
      "infra/terraform-native/terraform-lab-control",
    );
    for (const directive of [
      "--property=NoNewPrivileges=yes",
      "--property=Slice=terraform-lab.slice",
      "--property=CapabilityBoundingSet=",
      "--property=ProtectSystem=strict",
      "--property=ProtectHome=yes",
      "--property=PrivateDevices=yes",
      "--property=RestrictNamespaces=yes",
      "--property=MemoryDenyWriteExecute=yes",
      "--property=IPAddressDeny=any",
      "--property=TasksMax=96",
      "--property=ReadWritePaths=${state_dir}/home ${state_dir}/tmp",
    ]) {
      expect(control).toContain(directive);
    }
    expect(control).toContain(
      'common_scope_properties "$slot" 60 768M 640M',
    );
    expect(control).toContain(
      'common_scope_properties "$slot" "$runtime_max" 512M 448M',
    );
    expect(control).not.toContain("IPAddressAllow=169.254.169.254");
  });

  it("uses stale-safe expiry and full reset in app and root reapers", async () => {
    const [runtime, control, reaper] = await Promise.all([
      read("server/terraform-runtime.ts"),
      read("infra/terraform-native/terraform-lab-control"),
      read("infra/terraform-native/terraform-lab-reaper"),
    ]);
    expect(runtime).toContain("export class NativeTerraformRuntime implements LabRuntime");
    for (const method of [
      "initialize",
      "getOrCreate",
      "get",
      "reset",
      "destroy",
      "extend",
      "execute",
      "openTerminal",
      "cleanupExpired",
      "startJanitor",
      "close",
    ]) {
      expect(runtime).toContain(`${method}(`);
    }
    expect(runtime).toContain("cleanupExpiredLocked");
    expect(control).toContain('require_binding "$slot" "$generation" "$expected_expiry"');
    expect(control).toContain("10#$expected_expiry <= now");
    expect(control).toContain("prepare_slot_locked \"$slot\"");
    expect(reaper).toContain('expire "$slot" "$generation" "$expiry"');
  });

  it("keeps the Terraform web app in a separate hardened identity and slice", async () => {
    const [unit, slice] = await Promise.all([
      read("infra/systemd/terraform-lab-web.service"),
      read("infra/systemd/terraform-lab.slice"),
    ]);
    expect(unit).toContain("User=terraform-lab");
    expect(unit).toContain("Group=terraform-lab");
    expect(unit).toContain("Slice=terraform-lab.slice");
    expect(unit).toContain("IPAddressDeny=any");
    expect(unit).toContain("IPAddressAllow=localhost");
    expect(unit).toContain("AmbientCapabilities=");
    expect(unit).toContain("ExecStart=!/usr/bin/setpriv");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("/var/lib/terraform-lab/sessions");
    expect(unit).toContain("MemoryMax=768M");
    expect(slice).toContain("MemoryMax=3600M");
    expect(unit).not.toContain("vault-lab");
    expect(slice).not.toContain("vault-lab");
  });

  it("gates release activation on the full native curriculum smoke", async () => {
    const [installer, smoke, rebootSmoke] = await Promise.all([
      read("infra/install-terraform-application.sh"),
      read("server/terraform-curriculum-smoke.ts"),
      read("infra/terraform-reboot-smoke-deployment.sh"),
    ]);

    expect(installer).toContain(
      '"$NODE_BIN" "${release_dir}/dist-server/terraform-curriculum-smoke.js"',
    );
    expect(installer).toContain("sudo -u terraform-lab env -i");
    expect(installer).toContain(
      "/usr/bin/timeout --signal=TERM --kill-after=75s 2400s",
    );
    expect(installer.indexOf("terraform-curriculum-smoke.js")).toBeLessThan(
      installer.indexOf("printf '%s\\n' \"$target_commit\" >\"$release_marker\""),
    );
    expect(smoke).toContain("const EXPECTED_STEP_COUNT = 34");
    expect(smoke).toContain("createSessionId()");
    expect(smoke).toContain("await runtime.openTerminal(sessionId)");
    expect(smoke).toContain("isExactVerifierResult(step.id, result)");
    expect(smoke).toContain(
      'operation === "skip" ? step.skipSetup : step.validate',
    );
    expect(smoke).toContain('"skip-next-command"');
    expect(smoke).toContain("const shouldSkip = index % 2 === skipParity");
    expect(smoke).toContain("await runtime.destroy(sessionId)");
    expect(smoke).toContain("await runtime.close()");
    expect(smoke).not.toContain("console.error(result");
    expect(smoke).toContain("export async function runFirstSessionSmoke");
    expect(smoke).toContain('SMOKE_MODE === "first-session"');
    expect(rebootSmoke).toContain("systemctl stop \"$WEB_SERVICE\"");
    expect(rebootSmoke).toContain("TERRAFORM_SMOKE_MODE=first-session");
    expect(rebootSmoke).toContain(
      'PUBLIC_SMOKE=false "${CURRENT_DIR}/infra/terraform-smoke-deployment.sh"',
    );
    expect(rebootSmoke).toContain("systemd-tmpfiles-setup.service");
    expect(rebootSmoke).toContain("slot runtime directory is unsafe");
    expect(rebootSmoke).toContain("terraform-lab-terminal-*.service");
    expect(rebootSmoke).toContain("Terraform session metadata remains");
  });
});
