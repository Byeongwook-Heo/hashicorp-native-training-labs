import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspace = process.cwd();

describe("deployment cleanup safety contracts", () => {
  it("keeps the web broker unprivileged without blocking its pinned sudo helper", async () => {
    const [webUnit, smoke, systemdInstaller] = await Promise.all([
      readFile(
        path.join(workspace, "infra/systemd/vault-lab-web.service"),
        "utf8",
      ),
      readFile(path.join(workspace, "infra/smoke-deployment.sh"), "utf8"),
      readFile(
        path.join(workspace, "infra/install-systemd-units.sh"),
        "utf8",
      ),
    ]);

    expect(webUnit).toContain("User=vault-lab");
    expect(webUnit).toContain("NoNewPrivileges=no");
    expect(webUnit).toContain("AmbientCapabilities=");
    expect(webUnit).toContain("ProtectSystem=strict");
    expect(webUnit).toContain("IPAddressDeny=any");
    expect(webUnit).toContain("IPAddressAllow=localhost");
    expect(webUnit).toContain("ProcSubset=all");
    expect(webUnit).toContain("ReadOnlyPaths=/proc/sys /sys");
    expect(webUnit).toContain(
      "ReadWritePaths=/var/lib/vault-lab /run/vault-lab/app " +
        "/run/vault-lab/slots /run/lock/vault-lab-control /run/sudo",
    );
    expect(webUnit).toContain(
      "ExecStart=!/usr/bin/setpriv --reuid=vault-lab " +
        "--regid=vault-lab --clear-groups -- /usr/bin/node-22",
    );
    for (const sandboxDirective of [
      "PrivateDevices=yes",
      "ProtectKernelTunables=yes",
      "ProtectKernelModules=yes",
      "ProtectKernelLogs=yes",
      "ProtectClock=yes",
      "ProtectHostname=yes",
      "RestrictNamespaces=yes",
      "RestrictRealtime=yes",
      "LockPersonality=yes",
      "RestrictAddressFamilies=",
    ]) {
      expect(webUnit).toContain(sandboxDirective);
    }
    expect(webUnit).not.toContain("RestrictSUIDSGID=yes");
    expect(smoke).toContain('/^NoNewPrivs:/');
    expect(smoke).toContain('"0000000000000000"');
    expect(smoke).toContain('/^CapPrm:/');
    expect(smoke).toContain('/^CapAmb:/');
    expect(smoke).toContain(
      'nsenter -t "$web_pid" -m -- test -r /proc/sys/kernel/random/uuid',
    );
    expect(smoke).toContain(
      "sudo -n /usr/local/sbin/vault-lab-control terminal-count s01",
    );
    expect(smoke).toContain("Vault Lab deployment smoke 실패:");
    expect(smoke.indexOf("local_health=")).toBeLessThan(
      smoke.indexOf('web_pid="$(systemctl show'),
    );
    expect(smoke).toContain(
      '"$(systemctl show -p MainPID --value vault-lab-web.service)" == "$web_pid"',
    );
    expect(systemdInstaller).toContain(
      `"$(stat -c '%u:%g:%a' /usr/bin/setpriv)" != "0:0:755"`,
    );
  });

  it("uses the Amazon Linux 2023 compatible curl package", async () => {
    const sources = await Promise.all([
      readFile(path.join(workspace, "infra/ec2-user-data.sh"), "utf8"),
      readFile(path.join(workspace, "infra/native-install.sh"), "utf8"),
    ]);

    for (const source of sources) {
      expect(source).toMatch(/\n  curl-minimal \\\n/);
      expect(source).not.toMatch(/\n  curl \\\n/);
    }
  });

  it("launches only an owner-pinned approved AL2023 base AMI", async () => {
    const source = await readFile(
      path.join(workspace, "infra/deploy.sh"),
      "utf8",
    );

    expect(source).toContain(
      'readonly APPROVED_AMI_OWNER_ID="888995627335"',
    );
    expect(source).not.toContain(': "${APPROVED_AMI_OWNER_ID:=');
    expect(source).toContain('APPROVED_AMI_ID="${APPROVED_AMI_ID-}"');
    expect(source).toContain(': "${RESOLVE_LATEST_APPROVED_AMI:=false}"');
    expect(source).toContain(
      '"$RESOLVE_LATEST_APPROVED_AMI" != "true"',
    );
    expect(source).not.toContain(
      "/aws/service/ami-amazon-linux-latest/",
    );
    expect(source).toContain('--owners "$APPROVED_AMI_OWNER_ID"');
    expect(source).toContain(
      "hc-security-base-al2023-x86_64-*,hc-base-al2023-x86_64-*",
    );
    expect(source).toContain(
      '^hc-(security-)?base-al2023-x86_64-[0-9]{14}$',
    );
    for (const invariant of [
      '.OwnerId == $owner_id',
      '.State == "available"',
      '.Architecture == "x86_64"',
      '.RootDeviceType == "ebs"',
      '.RootDeviceName == "/dev/xvda"',
      '.VirtualizationType == "hvm"',
      '.ImageType == "machine"',
      '.PlatformDetails == "Linux/UNIX"',
      '.Public == false',
      '.ImdsSupport == "v2.0"',
      '.Ebs.DeleteOnTermination == true',
      '.Ebs.VolumeSize <= $root_volume_gb',
    ]) {
      expect(source).toContain(invariant);
    }
    expect(source).toContain(".DeprecationTime");
    expect(source).toContain("| fromdateiso8601");
    expect(source).toContain('--client-token "$client_token"');
    expect(source).toContain("Key=DeploymentId,Value=${deployment_id}");
    expect(source).toContain("Key=BaseAmiId,Value=${ami_id}");
    expect(source).toContain("Key=BaseAmiName,Value=${ami_name}");
    expect(source).toContain("Key=BaseAmiOwner,Value=${ami_owner_id}");
    expect(source).toContain(
      ".Reservations[0].Instances[0].ImageId == $ami_id",
    );
    expect(source).toContain(
      ".Reservations[0].Instances[0].ClientToken == $client_token",
    );
    expect(source).toContain("describe-instance-image-metadata");
    expect(source).toContain(
      ".[0].ImageMetadata.ImageAllowed != false",
    );
    expect(source).toContain(
      ".[0].ImageMetadata.OwnerId == $ami_owner_id",
    );
    expect(source).toContain(
      "&& candidate_image_metadata_matches_deployment",
    );
    expect(source).toContain(
      'and tag_value("BaseAmiName") == $ami_name',
    );

    const approvedImageCheck = source.indexOf(
      "AMI가 승인된 AL2023 base 계약을 충족하지 않습니다:",
    );
    const launch = source.indexOf("aws ec2 run-instances");
    expect(approvedImageCheck).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(approvedImageCheck);
  });

  it("reboots and smokes Terraform candidates before any DNS cutover", async () => {
    const source = await readFile(
      path.join(workspace, "infra/deploy.sh"),
      "utf8",
    );

    expect(source).toContain("capture_candidate_boot_id()");
    expect(source).toContain("capture_candidate_release_commit()");
    expect(source).toContain("reboot_terraform_candidate_before_cutover()");
    expect(source).toContain("aws ec2 reboot-instances");
    expect(source).toContain('[[ "$after_boot_id" != "$before_boot_id" ]]');
    expect(source).toContain(
      '"${APP_ROOT}/current/infra/terraform-reboot-smoke-deployment.sh"',
    );
    expect(source).toContain('EXPECTED_COMMIT="$expected_commit"');
    expect(source).toContain("local reboot_deadline=$((SECONDS + 900))");

    const installWait = source.indexOf(
      'wait_for_ssm_command "$install_command_id" 3600',
    );
    const rebootGate = source.indexOf(
      "reboot_terraform_candidate_before_cutover",
      installWait,
    );
    const dnsCutover = source.indexOf(
      'if [[ -n "$ROUTE53_HOSTED_ZONE_ID" ]]; then',
      rebootGate,
    );
    expect(installWait).toBeGreaterThan(-1);
    expect(rebootGate).toBeGreaterThan(installWait);
    expect(dnsCutover).toBeGreaterThan(rebootGate);
  });

  it("bounds failed release retention and cleans only exact inactive release directories", async () => {
    const source = await readFile(
      path.join(workspace, "infra/update-from-git.sh"),
      "utf8",
    );

    expect(source).toContain(': "${FAILED_RELEASE_RETENTION:=2}"');
    expect(source).toContain(
      '[[ ! "$FAILED_RELEASE_RETENTION" =~ ^[0-9]+$ ]]',
    );
    expect(source).toContain(
      '10#$FAILED_RELEASE_RETENTION > 20',
    );
    expect(source).toContain(
      '^[a-f0-9]{40}\\.failed\\.[0-9]{8}T[0-9]{6}Z(\\.[0-9]+)?$',
    );
    expect(source).toContain('|| -L "$entry_path"');
    expect(source).toContain(
      '[[ "$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)" == "$entry_path" ]]',
    );
    expect(source).toContain(
      'find "$entry_path" -xdev -mindepth 1 -delete',
    );
    expect(source).toContain('rmdir -- "$entry_path"');
    expect(source).toContain(
      'failed_release="${release_dir}.failed.$(date -u +%Y%m%dT%H%M%SZ).$$"',
    );

    const retryStart = source.indexOf(
      'if [[ "$release_is_ready" == "false" ]]',
    );
    const preBuildCleanup = source.indexOf(
      "\n  cleanup_failed_releases\n",
      retryStart,
    );
    const worktreeAdd = source.indexOf(
      'git -C "$REPOSITORY_DIR" worktree add',
      retryStart,
    );
    expect(retryStart).toBeGreaterThan(-1);
    expect(preBuildCleanup).toBeGreaterThan(retryStart);
    expect(worktreeAdd).toBeGreaterThan(preBuildCleanup);

    const activationSucceeded = source.indexOf("trap - ERR");
    const postDeployCleanup = source.lastIndexOf("cleanup_failed_releases");
    expect(activationSucceeded).toBeGreaterThan(-1);
    expect(postDeployCleanup).toBeGreaterThan(activationSucceeded);
  });

  it("removes only this run's exact candidate after a confirmed DNS rollback", async () => {
    const source = await readFile(
      path.join(workspace, "infra/deploy.sh"),
      "utf8",
    );

    expect(source).toContain(': "${KEEP_FAILED_CANDIDATE:=false}"');
    for (const booleanVariable of [
      '"$ALLOCATE_EIP"',
      '"$AUTO_INSTALL"',
      '"$KEEP_FAILED_CANDIDATE"',
      '"$RESOLVE_LATEST_APPROVED_AMI"',
    ]) {
      expect(source).toContain(booleanVariable);
    }
    expect(source).toContain("candidate_instance_matches_deployment()");
    expect(source).toContain("candidate_eip_matches_deployment()");
    expect(source).toContain("recover_candidate_instance_id()");
    expect(source).toContain("candidate_eip_is_safe_to_release()");
    expect(source).toContain("run_instances_attempted=true");
    expect(source).toContain("--no-allow-reassociation");
    for (const exactTag of [
      'tag_value("Project") == "VaultLab"',
      'tag_value("Runtime") == "Native"',
      'tag_value("Deployment") == "BlueGreenCandidate"',
      'tag_value("DeploymentId") == $deployment_id',
      'tag_value("VaultLabDeployKeyParameter") == $parameter_name',
    ]) {
      expect(source).toContain(exactTag);
    }
    expect(source).toContain('--instance-ids "$instance_id"');
    expect(source).toContain('--allocation-id "$allocation_id"');
    expect(source).toMatch(
      /candidate_eip_is_safe_to_release[\s\S]+aws ec2 release-address/,
    );
    expect(source).toContain(
      '"repos/${GITHUB_REPOSITORY}/keys/${deploy_key_id}"',
    );
    expect(source).toContain("Statement: (");
    expect(source).toContain(
      '+ (\n        if $kms_key == "" then []',
    );
    expect(source).toContain(
      "tail -n 200 /var/log/cloud-init-output.log >&2",
    );

    const cleanupStart = source.indexOf("cleanup() {");
    const cleanupEnd = source.indexOf("\n}\ntrap cleanup EXIT", cleanupStart);
    const cleanup = source.slice(cleanupStart, cleanupEnd);
    expect(cleanup).toContain("candidate_cleanup_safe=false");
    expect(cleanup).toContain(
      "aws route53 wait resource-record-sets-changed",
    );
    expect(source).not.toContain('Action: "UPSERT"');
    expect(cleanup).toMatch(
      /Action: "DELETE"[\s\S]+Action: "CREATE"/,
    );
    expect(cleanup).toContain(
      '[[ "$candidate_cleanup_blocked" != "true" ]]',
    );
    expect(cleanup).toMatch(
      /aws route53 wait resource-record-sets-changed[\s\S]+candidate_cleanup_safe=true/,
    );
    expect(cleanup).toContain(
      '[[ "$KEEP_FAILED_CANDIDATE" == "false" ]]',
    );
    expect(cleanup).toContain(
      '[[ "$candidate_cleanup_safe" == "true" ]]',
    );
    expect(cleanup).toContain("cleanup_created_candidate");

    const cutoverAttempt = source.lastIndexOf("dns_change_attempted=true");
    const route53Mutation = source.indexOf(
      "aws route53 change-resource-record-sets",
      cutoverAttempt,
    );
    const mutationConfirmed = source.indexOf(
      "dns_changed=true",
      route53Mutation,
    );
    expect(cutoverAttempt).toBeGreaterThan(-1);
    expect(route53Mutation).toBeGreaterThan(cutoverAttempt);
    expect(mutationConfirmed).toBeGreaterThan(route53Mutation);

    const forwardBatch = source.slice(
      source.indexOf('Comment: "Vault Lab blue/green candidate exact cutover"') - 600,
      source.indexOf('Comment: "Vault Lab blue/green candidate exact create"'),
    );
    expect(forwardBatch).toMatch(
      /Action: "DELETE"[\s\S]+Action: "CREATE"/,
    );
  });

  it("migrates native artifacts transactionally and fails closed across ABI changes", async () => {
    const [update, installer] = await Promise.all([
      readFile(path.join(workspace, "infra/update-from-git.sh"), "utf8"),
      readFile(path.join(workspace, "infra/native-install.sh"), "utf8"),
    ]);

    for (const installedArtifact of [
      "/usr/local/sbin/vault-lab-control",
      "/usr/local/libexec/vault-lab-shell",
      "/usr/local/libexec/vault-lab-exec",
      "/usr/local/sbin/vault-lab-loopback",
      "/usr/local/sbin/vault-lab-reaper",
      "/etc/systemd/system/vault-lab@.service",
      "/etc/systemd/system/vault-lab-loopback.service",
      "/etc/systemd/system/vault-lab-reaper.service",
      "/etc/systemd/system/vault-lab-reaper.timer",
      '"$NATIVE_ABI_FILE"',
    ]) {
      expect(update).toContain(installedArtifact);
    }
    expect(update).toContain("backup_native_artifacts()");
    expect(update).toContain("restore_native_artifacts()");
    expect(update).toContain("sync_native_artifacts()");
    expect(update).toContain("commit_native_abi()");
    expect(update).toMatch(/systemd-analyze sync; do/);
    expect(update).toContain(
      "native_artifact_was_present[artifact_index]=true",
    );
    expect(update).toContain(
      "native_previous_runtime_complete=false",
    );
    expect(update).toContain(
      '[[ "$slot_unit" =~ ^vault-lab@s[0-9]{2}\\.service$ ]]',
    );
    expect(update).toContain(
      'printf \'updating-%s\\n\' "$release_native_control_abi"',
    );
    expect(update).toContain(
      '"const NATIVE_CONTROL_ABI = \\"${release_native_control_abi}\\";"',
    );

    const sentinelWriter = update.indexOf("write_native_abi_sentinel() {");
    const sentinel = update.indexOf(
      'mv -fT -- "$temporary_path" "$NATIVE_ABI_FILE"',
      sentinelWriter,
    );
    const sentinelFlush = update.indexOf(
      'sync -f "$NATIVE_ABI_FILE"',
      sentinel,
    );
    expect(sentinel).toBeGreaterThan(sentinelWriter);
    expect(sentinelFlush).toBeGreaterThan(sentinel);

    const nativeGateStage = update.indexOf(
      'if [[ "$native_smoke_required" == "true" ]]; then\n' +
        '  echo "native runtime 갱신을 위해 web 요청을 정상 종료합니다."',
    );
    const webDisable = update.indexOf(
      "systemctl disable vault-lab-web.service",
      nativeGateStage,
    );
    const reaperDisable = update.indexOf(
      "systemctl disable vault-lab-reaper.timer",
      webDisable,
    );
    const loopbackDisable = update.indexOf(
      "systemctl disable vault-lab-loopback.service",
      reaperDisable,
    );
    const consumersQuiesced = update.indexOf(
      "assert_native_consumers_quiesced",
      loopbackDisable,
    );
    const transactionStart = update.indexOf(
      "native_sync_started=true",
      consumersQuiesced,
    );
    const smokePendingWrite = update.indexOf(
      'write_native_smoke_pending "$native_smoke_pending_write_kind"',
      transactionStart,
    );
    const sentinelCall = update.indexOf(
      "write_native_abi_sentinel",
      smokePendingWrite,
    );
    const payloadSync = update.indexOf("sync_native_artifacts", sentinelCall);
    expect(webDisable).toBeGreaterThan(nativeGateStage);
    expect(reaperDisable).toBeGreaterThan(webDisable);
    expect(loopbackDisable).toBeGreaterThan(reaperDisable);
    expect(consumersQuiesced).toBeGreaterThan(loopbackDisable);
    const consumerAssertion = update.slice(
      update.indexOf("assert_native_consumers_quiesced() {"),
      nativeGateStage,
    );
    const updateEnabledLoop = consumerAssertion.indexOf(
      "for unit_name in",
      consumerAssertion.indexOf(
        'systemctl is-active --quiet "$unit_name"',
      ),
    );
    expect(
      consumerAssertion.slice(0, updateEnabledLoop),
    ).toContain("vault-lab-reaper.service");
    expect(
      consumerAssertion.slice(
        updateEnabledLoop,
        consumerAssertion.indexOf(
          'systemctl is-enabled --quiet "$unit_name"',
          updateEnabledLoop,
        ),
      ),
    ).not.toContain("vault-lab-reaper.service");
    expect(update).not.toContain(
      "systemctl disable vault-lab-reaper.service",
    );
    expect(transactionStart).toBeGreaterThan(consumersQuiesced);
    expect(smokePendingWrite).toBeGreaterThan(transactionStart);
    expect(sentinelCall).toBeGreaterThan(smokePendingWrite);
    expect(payloadSync).toBeGreaterThan(sentinelCall);

    const sameAbiDeploy = update.lastIndexOf("sync_native_artifacts");
    const daemonReload = update.indexOf("systemctl daemon-reload", sameAbiDeploy);
    const unitVerify = update.indexOf("systemd-analyze verify", daemonReload);
    const loopbackReady = update.indexOf(
      "systemctl is-active --quiet vault-lab-loopback.service",
      unitVerify,
    );
    const abiCommit = update.indexOf("commit_native_abi", loopbackReady);
    expect(daemonReload).toBeGreaterThan(sameAbiDeploy);
    expect(unitVerify).toBeGreaterThan(daemonReload);
    expect(loopbackReady).toBeGreaterThan(unitVerify);
    expect(abiCommit).toBeGreaterThan(loopbackReady);

    const rollback = update.slice(
      update.indexOf("rollback() {"),
      update.indexOf("\n}\ntrap rollback ERR"),
    );
    expect(rollback).toContain(
      '[[ "$native_migration_started" == "true" ]]',
    );
    expect(rollback).toContain("native_rollback_succeeded=false");
    expect(rollback).toContain(
      '&& "$native_rollback_succeeded" == "true"',
    );
    expect(rollback).toContain(
      '&& "$native_previous_runtime_complete" == "true"',
    );
    expect(rollback).toContain(
      "systemctl disable vault-lab-web.service",
    );

    const installerStop = installer.indexOf(
      "systemctl stop vault-lab-web.service",
    );
    const installerDisable = installer.indexOf(
      "systemctl disable vault-lab-web.service",
      installerStop,
    );
    const installerSentinel = installer.indexOf(
      "mv -fT -- \"$abi_sentinel_temporary\" /etc/vault-lab/native-control-abi",
    );
    const installerPackages = installer.indexOf("dnf install -y");
    const installerVerification = installer.lastIndexOf(
      "systemd-analyze verify",
    );
    const installerCommit = installer.lastIndexOf(
      "mv -fT -- \"$abi_marker_temporary\" /etc/vault-lab/native-control-abi",
    );
    const installerLoopbackEnable = installer.lastIndexOf(
      "systemctl enable vault-lab-loopback.service",
    );
    const installerReaperEnable = installer.lastIndexOf(
      "systemctl enable --now vault-lab-reaper.timer",
    );
    expect(installerStop).toBeGreaterThan(-1);
    expect(installerDisable).toBeGreaterThan(installerStop);
    expect(installerSentinel).toBeGreaterThan(installerDisable);
    expect(installerPackages).toBeGreaterThan(installerSentinel);
    expect(installerLoopbackEnable).toBeGreaterThan(installerVerification);
    expect(installerReaperEnable).toBeGreaterThan(installerLoopbackEnable);
    expect(installerCommit).toBeGreaterThan(installerVerification);
    expect(installerCommit).toBeGreaterThan(installerReaperEnable);
    expect(installer.slice(installerSentinel)).not.toContain(
      "systemctl enable vault-lab-web.service",
    );
    expect(installer).toContain(
      "sync -f /etc/vault-lab/native-control-abi",
    );
  });

  it("keeps web fail-closed until a durable native smoke gate is cleared", async () => {
    const [update, installer, webUnit] = await Promise.all([
      readFile(path.join(workspace, "infra/update-from-git.sh"), "utf8"),
      readFile(path.join(workspace, "infra/native-install.sh"), "utf8"),
      readFile(
        path.join(workspace, "infra/systemd/vault-lab-web.service"),
        "utf8",
      ),
    ]);

    expect(update).toContain(
      'readonly NATIVE_SMOKE_PENDING_FILE="/etc/vault-lab/native-smoke-pending"',
    );
    expect(update).toContain("write_native_smoke_pending()");
    expect(update).toContain("assert_native_smoke_pending()");
    expect(update).toContain("clear_native_smoke_pending()");
    expect(update).toContain('"0:0:600"');
    expect(update).toContain(
      '[[ "${BASH_REMATCH[1]}" == "$release_native_control_abi" ]]',
    );
    expect(update).toContain(
      '&& "$native_smoke_pending_abi" != "$release_native_control_abi"',
    );
    expect(update).toContain("native_runtime_needs_sync=true");
    expect(update).toContain(
      '|| "$native_runtime_needs_sync" == "true"',
    );
    expect(update).toContain(
      'native_migration_started="$native_migration_pending"',
    );

    const pendingWrite = update.lastIndexOf(
      'write_native_smoke_pending "$native_smoke_pending_write_kind"',
    );
    const abiSentinel = update.indexOf(
      "write_native_abi_sentinel",
      pendingWrite,
    );
    const nativeSmoke = update.lastIndexOf(
      '"${release_dir}/infra/smoke-native-runtime.sh" "$release_dir"',
    );
    const currentActivation = update.lastIndexOf(
      'mv -Tf "$temporary_link" "$CURRENT_LINK"',
    );
    const pendingClear = update.lastIndexOf("clear_native_smoke_pending");
    const webEnable = update.lastIndexOf(
      "systemctl enable vault-lab-web.service",
    );
    expect(pendingWrite).toBeGreaterThan(-1);
    expect(abiSentinel).toBeGreaterThan(pendingWrite);
    expect(nativeSmoke).toBeGreaterThan(abiSentinel);
    expect(currentActivation).toBeGreaterThan(nativeSmoke);
    expect(pendingClear).toBeGreaterThan(currentActivation);
    expect(webEnable).toBeGreaterThan(pendingClear);

    const rollback = update.slice(
      update.indexOf("rollback() {"),
      update.indexOf("\n}\ntrap rollback ERR"),
    );
    expect(rollback).toContain("native_smoke_gate_present=true");
    expect(rollback).toContain(
      '&& "$native_smoke_gate_present" == "false"',
    );

    const installerPending = installer.indexOf(
      'mv -fT -- "$smoke_pending_temporary" "$NATIVE_SMOKE_PENDING_FILE"',
    );
    const installerWebDisable = installer.indexOf(
      "systemctl disable vault-lab-web.service",
    );
    const installerSystemdSync = installer.indexOf(
      "sync -f /etc/systemd/system",
      installerWebDisable,
    );
    const installerActiveStateLoop = installer.indexOf(
      "for native_consumer in",
      installerSystemdSync,
    );
    const installerActiveStateCheck = installer.indexOf(
      'systemctl is-active --quiet "$native_consumer"',
      installerActiveStateLoop,
    );
    const installerEnabledStateLoop = installer.indexOf(
      "for native_consumer in",
      installerActiveStateCheck,
    );
    const installerEnabledStateCheck = installer.indexOf(
      'systemctl is-enabled --quiet "$native_consumer"',
      installerEnabledStateLoop,
    );
    const installerAbiSentinel = installer.indexOf(
      'mv -fT -- "$abi_sentinel_temporary" /etc/vault-lab/native-control-abi',
    );
    expect(installerWebDisable).toBeGreaterThan(-1);
    expect(installerSystemdSync).toBeGreaterThan(installerWebDisable);
    expect(installerActiveStateLoop).toBeGreaterThan(installerSystemdSync);
    expect(installerActiveStateCheck).toBeGreaterThan(
      installerActiveStateLoop,
    );
    expect(installerEnabledStateLoop).toBeGreaterThan(
      installerActiveStateCheck,
    );
    expect(installerEnabledStateCheck).toBeGreaterThan(
      installerEnabledStateLoop,
    );
    expect(installerPending).toBeGreaterThan(installerEnabledStateCheck);
    expect(
      installer.slice(installerActiveStateLoop, installerPending),
    ).toContain("vault-lab-reaper.timer");
    expect(
      installer.slice(installerActiveStateLoop, installerPending),
    ).toContain("vault-lab-reaper.service");
    expect(
      installer.slice(installerEnabledStateLoop, installerEnabledStateCheck),
    ).not.toContain("vault-lab-reaper.service");
    expect(installer).not.toContain(
      "systemctl disable vault-lab-reaper.service",
    );
    expect(
      installer.slice(installerActiveStateLoop, installerPending),
    ).toContain("vault-lab-loopback.service");
    expect(installerPending).toBeGreaterThan(-1);
    expect(installerAbiSentinel).toBeGreaterThan(installerPending);
    expect(installer).toContain(
      "'native-smoke-pending:%s:migration\\n'",
    );
    expect(installer).not.toContain(
      'rm -f -- "$NATIVE_SMOKE_PENDING_FILE"',
    );

    const pendingExistsGate = webUnit.indexOf(
      "ExecStartPre=/usr/bin/test ! -e /etc/vault-lab/native-smoke-pending",
    );
    const pendingLinkGate = webUnit.indexOf(
      "ExecStartPre=/usr/bin/test ! -L /etc/vault-lab/native-smoke-pending",
    );
    const applicationGate = webUnit.indexOf(
      "ExecStartPre=/usr/bin/test -r /opt/vault-lab/current/dist-server/index.js",
    );
    expect(pendingExistsGate).toBeGreaterThan(-1);
    expect(pendingLinkGate).toBeGreaterThan(pendingExistsGate);
    expect(applicationGate).toBeGreaterThan(pendingLinkGate);
  });
});
