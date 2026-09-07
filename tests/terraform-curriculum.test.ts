import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { terraformSteps } from "../server/terraform-curriculum.js";

const expectedIds = [
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

const step = (id: (typeof expectedIds)[number]) =>
  terraformSteps.find((item) => item.id === id)!;

const count = (text: string, pattern: string) =>
  text.split(pattern).length - 1;

const executableText = () =>
  terraformSteps
    .flatMap((item) => [item.command, item.skipSetup[2]])
    .join("\n");

describe("Terraform curriculum", () => {
  it("keeps exactly 8 contiguous labs and the ordered 34-stage contract", () => {
    expect(terraformSteps).toHaveLength(34);
    expect(terraformSteps.map((item) => item.id)).toEqual(expectedIds);
    expect(new Set(terraformSteps.map((item) => item.id)).size).toBe(34);
    expect([...new Set(terraformSteps.map((item) => item.lab))]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(terraformSteps.filter((item) => item.lab === 7).map((item) => item.id))
      .toEqual([
        "workspace-stage",
        "replace-release",
        "refresh-only",
        "safe-destroy",
      ]);
    expect(terraformSteps.filter((item) => item.lab === 8).map((item) => item.id))
      .toEqual([
        "agent-skills-catalog",
        "agent-skills-select",
        "agent-skills-install",
        "agent-skills-guided-test",
      ]);
  });

  it("keeps every public command, verifier, and skip fixture shell-valid", () => {
    for (const item of terraformSteps) {
      expect(item.command.trim().length, item.id).toBeGreaterThan(0);
      expect(item.objective.trim().length, item.id).toBeGreaterThan(0);
      expect(item.description.trim().length, item.id).toBeGreaterThan(0);
      expect(item.concept.trim().length, item.id).toBeGreaterThan(0);
      expect(item.expected.trim().length, item.id).toBeGreaterThan(0);
      expect(item.hint.trim().length, item.id).toBeGreaterThan(0);
      expect(item.troubleshooting.length, item.id).toBeGreaterThan(0);
      expect(item.success.trim().length, item.id).toBeGreaterThan(0);

      for (const [kind, script] of [
        ["command", item.command],
        ["validate", item.validate[2]],
        ["skipSetup", item.skipSetup[2]],
      ] as const) {
        const parsed = spawnSync("/bin/sh", ["-n"], {
          input: `set -eu\n${script}\n`,
          encoding: "utf8",
        });
        expect(
          parsed.status,
          `${item.id}/${kind}: ${parsed.stderr}`,
        ).toBe(0);
      }
    }
  });

  it("uses argv verifiers and fixtures with one exact server marker", () => {
    for (const item of terraformSteps) {
      const expectedMarker = `verified:${item.id}`;
      expect(item.validate.slice(0, 2), item.id).toEqual(["/bin/sh", "-c"]);
      expect(item.skipSetup.slice(0, 2), item.id).toEqual(["/bin/sh", "-c"]);
      expect(item.expect, item.id).toEqual([expectedMarker]);
      expect(count(item.validate[2], expectedMarker), `${item.id}/validate`)
        .toBe(1);
      expect(count(item.skipSetup[2], expectedMarker), `${item.id}/skipSetup`)
        .toBe(1);
      expect(item.validate[2].trimEnd(), item.id)
        .toMatch(new RegExp(`printf '[^']*' '${expectedMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`));
      expect(item.skipSetup[2].trimEnd(), item.id)
        .toMatch(new RegExp(`printf '[^']*' '${expectedMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`));
    }
  });

  it("pins Terraform and every approved provider to the exact release", () => {
    const text = executableText();
    const providerSources = [...text.matchAll(/source\s*=\s*"(hashicorp\/[^"]+)"/g)]
      .map((match) => match[1]);

    expect(new Set(providerSources)).toEqual(new Set([
      "hashicorp/local",
      "hashicorp/random",
      "hashicorp/null",
      "hashicorp/tls",
    ]));
    expect(text).toContain('required_version = "= 1.15.8"');
    expect(text).toContain('source  = "hashicorp/local"\n      version = "2.5.3"');
    expect(text).toContain('source  = "hashicorp/random"\n      version = "3.7.2"');
    expect(text).toContain('source  = "hashicorp/null"\n      version = "3.2.4"');
    expect(text).toContain('source  = "hashicorp/tls"\n      version = "4.1.0"');
    expect(text).not.toMatch(/\bversion\s*=\s*"(?:~>|>=|<=|>|<|\^)/);
  });

  it("keeps learner and fixture execution local, offline, and provisioner-free", () => {
    const text = executableText();

    for (const forbidden of [
      /docker/i,
      /\bsudo\b/i,
      /\b(?:curl|wget)\b/i,
      /\bprovisioner\s+"/i,
      /\blocal-exec\b/i,
      /\bremote-exec\b/i,
      /\bbackend\s+"/i,
      /\bcloud\s*\{/i,
      /source\s*=\s*"(?:git::|https?:|s3::|gcs::)/i,
      /provider\s+"aws"/i,
      /\b(?:resource|data)\s+"aws_/i,
      /\baws\s+(?:ec2|sts|iam|s3)\b/i,
    ]) {
      expect(text).not.toMatch(forbidden);
    }

    for (const item of terraformSteps.slice(1)) {
      expect(item.command, item.id).toContain("$HOME/terraform-lab");
      expect(item.skipSetup[2], item.id).toContain("$HOME/terraform-lab");
      expect(item.command, item.id).toContain("test ! -L");
      expect(item.skipSetup[2], item.id).toContain("test ! -L");
    }
  });

  it("contains no AWS resources or mutable external infrastructure path", () => {
    const text = terraformSteps
      .flatMap((item) => [
        item.command,
        item.validate[2],
        item.skipSetup[2],
      ])
      .join("\n");

    expect(text).not.toMatch(/\b(?:resource|data)\s+"aws_/i);
    expect(text).not.toMatch(/provider\s+"aws"/i);
    expect(text).not.toMatch(/terraform\s+import\b/i);
    expect(text).not.toMatch(/terraform\s+force-unlock\b/i);
    expect(text).not.toMatch(/terraform\s+state\s+rm\b/i);
  });

  it("requires a saved-plan JSON gate before every destructive apply", () => {
    for (const [id, plan] of [
      ["backup-destroy", "destroy.tfplan"],
      ["safe-destroy", "safe-destroy.tfplan"],
    ] as const) {
      const item = step(id);
      for (const script of [item.command, item.skipSetup[2]]) {
        const planIndex = script.indexOf(`terraform plan -destroy`);
        const showIndex = script.indexOf(`terraform show -json ${plan}`);
        const gateIndex = script.indexOf('$managed[0].change.actions == ["delete"]');
        const applyIndex = script.lastIndexOf(
          `terraform apply -input=false -no-color ${plan}`,
        );
        expect(planIndex, `${id}/plan`).toBeGreaterThanOrEqual(0);
        expect(showIndex, `${id}/show`).toBeGreaterThan(planIndex);
        expect(gateIndex, `${id}/gate`).toBeGreaterThan(showIndex);
        expect(applyIndex, `${id}/apply`).toBeGreaterThan(gateIndex);
        expect(script.slice(showIndex, applyIndex), id).toContain(
          '($managed | length) == 1',
        );
      }
    }

    const replacement = step("replace-release").command;
    expect(replacement.indexOf("terraform show -json replace.tfplan"))
      .toBeLessThan(replacement.lastIndexOf("terraform apply -input=false -no-color replace.tfplan"));
    expect(replacement).toContain('[.resource_changes[]? | select(.mode == "managed")] as $managed');
    expect(replacement).toContain('($managed | length) == 1');
    expect(step("replace-release").skipSetup[2]).toContain(
      '[.resource_changes[]? | select(.mode == "managed")] as $managed',
    );
    expect(replacement).toContain('["delete", "create"]');
  });

  it("re-executes behavioral checks instead of trusting learner artifacts", () => {
    const conditions = step("conditions-checks").validate[2];

    expect(conditions).toContain("terraform validate -no-color");
    expect(conditions).toContain('.address.kind == "check"');
    expect(conditions).toContain('.address.name == "secure_private_key_file"');
    expect(conditions).toContain("-var=key_algorithm=DES");
    expect(conditions).toContain('test "$negative_status" -ne 0');
    expect(conditions).toContain('file_permission = "0644"');
    expect(conditions).toContain('.status == "fail"');
    expect(conditions).toContain("Private key files must use mode 0600.");
    expect(conditions).not.toContain("grep -F 'check \"secure_private_key_file\"' main.tf");
  });

  it("proves auto.tfvars provenance and the explicit dependency edge", () => {
    const autoTfvars = step("auto-tfvars").validate[2];
    const dependency = step("explicit-dependency").validate[2];

    expect(autoTfvars).toContain("with-auto.tfplan");
    expect(autoTfvars).toContain("without-auto.tfplan");
    expect(autoTfvars).toContain('"name": "payments-stage"');
    expect(autoTfvars).toContain('"name": "payments-dev"');
    expect(dependency).toContain(
      '"[root] null_resource.manifest_gate (expand)" -> "[root] local_file.service (expand)"',
    );
    expect(dependency).toContain('"contract" = "all-service-files-ready"');
  });

  it("uses complete plan sets for drift, refresh, and replace gates", () => {
    for (const script of [
      step("drift-detect").validate[2],
      step("drift-reconcile").command,
      step("drift-reconcile").skipSetup[2],
    ]) {
      expect(script).toContain("[.resource_drift[]?] as $drift");
      expect(script).toContain(
        '[.resource_changes[]? | select(.mode == "managed")] as $managed',
      );
    }
    for (const script of [
      step("refresh-only").command,
      step("refresh-only").validate[2],
      step("refresh-only").skipSetup[2],
    ]) {
      expect(script).toContain("[.resource_drift[]?] as $drift");
      expect(script).toContain('$drift[0].address == "local_file.release"');
    }
  });

  it("keeps sensitive values out of learner-visible output artifacts", () => {
    const commands = terraformSteps.map((item) => item.command).join("\n");
    const sensitive = step("sensitive-random");
    const safeOutput = step("safe-output");
    const stateAudit = step("sensitive-state-audit");

    expect(commands).not.toMatch(/terraform\s+output(?:\s+-\S+)*\s+api_password\b/);
    expect(commands).not.toMatch(/terraform\s+output\s+-json\s*(?:\||>|$)/m);
    expect(commands).not.toMatch(/cat\s+(?:\.\/)?terraform\.tfstate\b/);
    expect(commands).not.toMatch(/cat\s+artifacts\/learner-key\b/);
    expect(commands).not.toMatch(/output\s+"(?:private|private_key|credential)"/i);
    expect(sensitive.command).toContain('output "api_password"');
    expect(sensitive.command).toContain("sensitive = true");
    expect(safeOutput.command).toContain("terraform output -json configuration");
    expect(stateAudit.command).toContain(".sensitive_values.private_key_openssh == true");
    expect(stateAudit.command).toContain("' >/dev/null");
    expect(stateAudit.command).not.toContain(".values.private_key_openssh");
    expect(step("module-output").command)
      .toContain("terraform output -json artifact_paths");
  });

  it("materializes real prerequisites in skip fixtures", () => {
    for (const item of terraformSteps.slice(1)) {
      expect(item.skipSetup[2], item.id).toContain(
        'find "$resolved_project" -xdev -mindepth 1 -delete',
      );
    }
    expect(step("saved-plan").skipSetup[2]).toContain(
      "terraform plan -input=false -no-color -out=workflow.tfplan",
    );
    expect(step("apply-local").skipSetup[2]).toContain(
      "terraform apply -input=false -no-color workflow.tfplan",
    );
    expect(step("sensitive-random").skipSetup[2]).toContain(
      'resource "random_password" "api"',
    );
    expect(step("drift-detect").skipSetup[2]).toContain("manual drift");
    expect(step("drift-reconcile").skipSetup[2]).toContain(
      "terraform apply -input=false -no-color drift.tfplan",
    );
    expect(step("moved-refactor").skipSetup[2]).toContain("moved {");
    expect(step("terraform-test").skipSetup[2]).toContain(
      "terraform test -no-color",
    );
    expect(step("workspace-stage").skipSetup[2]).toContain(
      "terraform workspace select stage",
    );
    expect(step("refresh-only").skipSetup[2]).toContain(
      "terraform plan -refresh-only",
    );
    expect(step("safe-destroy").skipSetup[2]).toContain(
      "terraform plan -destroy",
    );
  });

  it("teaches Agent Skills through an immutable offline snapshot and deterministic checks", () => {
    const catalog = step("agent-skills-catalog");
    const select = step("agent-skills-select");
    const install = step("agent-skills-install");
    const guided = step("agent-skills-guided-test");
    const agentText = [catalog, select, install, guided]
      .flatMap((item) => [item.command, item.validate[2], item.skipSetup[2]])
      .join("\n");

    expect(catalog.concept).toContain("AI 코딩 에이전트");
    expect(catalog.concept).toContain("Terraform을 대신 실행하거나 권한을 제공");
    expect(catalog.command).toContain(
      "4451ceca5456e79cc776efee96a744f7ac96e5bf",
    );
    expect(catalog.validate[2]).toContain("skill_count == 16");
    expect(catalog.command).toContain("skill-capabilities.json");
    expect(catalog.command).toContain("unreleased-main-snapshot");
    expect(catalog.command).toContain("terraform-search-import");
    expect(catalog.command).toContain("provider-ephemeral-resources");
    expect(catalog.concept).toContain("포함된 명령·스크립트");
    expect(select.command).toContain("terraform-style-guide");
    expect(select.command).toContain("terraform-test");
    expect(install.command).toContain(".agents/skills");
    expect(install.command).toContain("cp -R");
    expect(install.command).not.toContain("cp -a");
    expect(install.validate[2]).toContain("diff -r");
    expect(install.validate[2]).toContain("sha256sum -c");
    expect(install.validate[2]).toContain("installed_manifest_inventory");
    expect(install.validate[2]).toContain("actual_installed_inventory");
    expect(install.command).toContain("compatible_agent_discovery");
    expect(install.command).toContain("agent_invoked_in_lab");
    expect(guided.concept).toContain("offline reference fixture");
    expect(guided.validate[2]).toContain("terraform fmt -check");
    expect(guided.validate[2]).toContain("terraform validate");
    expect(guided.validate[2]).toContain("terraform test");
    expect(guided.validate[2]).toContain("terraform show -json");
    expect(guided.validate[2]).toContain('agent_invoked == false');
    expect(guided.validate[2]).toContain("expected-agent-guided.tftest.hcl");
    expect(guided.validate[2]).toContain("cmp -s tests/agent-guided.tftest.hcl");
    expect(catalog.validate[2]).toContain("actual_snapshot_inventory");
    expect(catalog.validate[2]).toContain("! -perm 0555");
    expect(catalog.validate[2]).toContain("expected-skill-capabilities.json");
    expect(catalog.validate[2]).toContain("cmp -s artifacts/skill-capabilities.json");
    expect(agentText).not.toMatch(/\bnpx\s+skills\s+add\b/);
    expect(agentText).not.toMatch(/list_resources\.sh/);
    expect(agentText).not.toMatch(/\bgit\s+(?:clone|fetch)\b/);
  });
});
