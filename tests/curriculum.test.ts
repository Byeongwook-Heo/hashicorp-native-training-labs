import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { steps } from "../server/curriculum.js";

describe("Vault curriculum", () => {
  it("uses unique step ids and contiguous lab numbers", () => {
    expect(steps).toHaveLength(30);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
    const labs = [...new Set(steps.map((step) => step.lab))];
    expect(labs).toEqual(Array.from({ length: Math.max(...labs) }, (_, index) => index + 1));
    expect(steps.map((step) => step.id)).toEqual(expect.arrayContaining([
      "kv-soft-delete",
      "kv-restore"
    ]));
    expect(steps.map((step) => step.id)).not.toContain("delete-restore");
  });

  it("keeps every step executable, explainable, and recoverable after skip", () => {
    for (const step of steps) {
      expect(step.command.trim().length, step.id).toBeGreaterThan(0);
      expect(step.validate.length, step.id).toBeGreaterThan(0);
      expect(step.skipSetup.length, step.id).toBeGreaterThan(0);
      expect(step.objective.trim().length, step.id).toBeGreaterThan(0);
      expect(step.troubleshooting.length, step.id).toBeGreaterThan(0);
      expect(step.command, step.id).not.toMatch(/docker/i);
      const parsedCommand = spawnSync("/bin/sh", ["-n"], {
        input: `set -eu\n${step.command}\n`,
        encoding: "utf8"
      });
      expect(parsedCommand.status, `${step.id}: ${parsedCommand.stderr}`).toBe(0);
    }
  });

  it("uses syntax-valid root verifiers with one exact, step-specific marker", () => {
    for (const step of steps) {
      expect(step.validate.slice(0, 2), step.id).toEqual(["/bin/sh", "-c"]);
      expect(step.expect, step.id).toEqual([`verified:${step.id}`]);
      expect(
        step.validate[2].split(`verified:${step.id}`).length - 1,
        step.id
      ).toBe(1);

      for (const argv of [step.validate, step.skipSetup]) {
        if (argv[0] !== "/bin/sh") continue;
        const parsed = spawnSync("/bin/sh", ["-n"], {
          input: argv[2],
          encoding: "utf8"
        });
        expect(parsed.status, `${step.id}: ${parsed.stderr}`).toBe(0);
      }
    }
  });

  it("removes dev-mode and implicit secret mount assumptions", () => {
    const status = steps.find((step) => step.id === "status")!;
    const secrets = steps.find((step) => step.id === "secrets-list")!;
    expect(status.expected).toContain("file");
    expect(status.validate[2]).toContain('.storage_type == "file"');
    expect(`${status.concept} ${status.expected}`).not.toMatch(/dev mode|inmem/i);
    expect(secrets.expected).not.toContain("secret/");
    expect(secrets.expect).toEqual(["verified:secrets-list"]);
    expect(secrets.validate[2]).not.toContain('["secret/"]');
  });

  it("uses exact KV v2 mounts, CAS writes, and observable delete/restore states", () => {
    const enable = steps.find((step) => step.id === "enable-kv")!;
    const writeV1 = steps.find((step) => step.id === "write-v1")!;
    const writeV2 = steps.find((step) => step.id === "write-v2")!;
    const softDelete = steps.find((step) => step.id === "kv-soft-delete")!;
    const restore = steps.find((step) => step.id === "kv-restore")!;

    expect(enable.validate[2]).toContain('.options.version == "2"');
    expect(writeV1.command).toContain("-mount=training -cas=0");
    expect(writeV2.command).toContain("-mount=training -cas=1");
    expect(softDelete.validate[2]).toContain('deletion_time != ""');
    expect(softDelete.validate[2]).toContain("vault kv get -mount=training -version=2");
    expect(restore.validate[2]).toContain('deletion_time == ""');
    expect(restore.validate[2]).toContain('"RotatedPass456!"');
  });

  it("keeps policy and token escalation boundaries exact", () => {
    const policy = steps.find((step) => step.id === "policy-write")!;
    const capabilities = steps.find((step) => step.id === "capabilities")!;
    const limited = steps.find((step) => step.id === "limited-token")!;
    const lookup = steps.find((step) => step.id === "token-lookup")!;

    expect(policy.command).toContain("/tmp/app-read.hcl");
    expect(policy.command).toContain('training/data/myapp/config');
    expect(policy.command).not.toContain("*");
    expect(policy.command).toContain('capabilities = ["read"]');
    expect(policy.command).not.toContain("vault policy write");
    expect(steps.every((step) => !step.command.includes("auth/token/roles/"))).toBe(true);
    expect(steps.every((step) => !/vault token revoke(?! -accessor)/.test(step.command))).toBe(true);
    expect(capabilities.command).toContain("auth/token/create/app-read-role");
    expect(limited.command).toContain("auth/token/create/app-read-role");
    expect(limited.validate[2]).toContain(".data.token_explicit_max_ttl == 1800");
    expect(limited.validate[2]).toContain(".data.renewable == false");
    expect(lookup.command).toContain("/tmp/token-audit.json");
    expect(lookup.command).not.toContain("client_token}");
  });

  it("contains structured AppRole, Transit, Audit, deny, and revoke verification", () => {
    expect(steps.map((step) => step.id)).toEqual(expect.arrayContaining([
      "audit-enable",
      "deny-drill",
      "revoke-drill",
      "pki-issue"
    ]));

    expect(steps.find((step) => step.id === "approle-role")!.validate[2])
      .toContain(".data.secret_id_ttl == 600");
    expect(steps.find((step) => step.id === "transit-encrypt")!.validate[2])
      .toContain("transit/decrypt/customer-data");
    expect(steps.find((step) => step.id === "transit-rotate")!.validate[2])
      .toContain('"vault:v$LATEST:"');
    expect(steps.find((step) => step.id === "audit-inspect")!.validate[2])
      .toContain("group_by(.request.id)");
    expect(steps.find((step) => step.id === "audit-enable")!.command)
      .toContain('.options.mode == "0640"');
    expect(steps.find((step) => step.id === "audit-enable")!.command)
      .toContain('.options.log_raw == "false"');
    expect(steps.find((step) => step.id === "deny-drill")!.validate[2])
      .toContain("training/data/myapp/blocked");
    expect(steps.find((step) => step.id === "revoke-drill")!.command)
      .toContain("vault token revoke -accessor");
  });

  it("hardens the PKI role and verifies issued certificates cryptographically", () => {
    const role = steps.find((step) => step.id === "pki-role")!;
    const issue = steps.find((step) => step.id === "pki-issue")!;

    for (const setting of [
      "allow_bare_domains=false",
      "allow_glob_domains=false",
      "allow_wildcard_certificates=false",
      "allow_ip_sans=false",
      "allow_localhost=false"
    ]) {
      expect(role.command).toContain(setting);
    }
    expect(issue.validate[2]).toContain("openssl x509");
    expect(issue.validate[2]).toContain("subjectAltName");
    expect(issue.validate[2]).toContain("openssl pkey");
    expect(issue.validate[2]).toContain("openssl verify");
    expect(issue.validate[2]).toContain("NOT_AFTER - NOT_BEFORE");
    expect(issue.validate[2]).not.toContain("grep -q 'api.example.internal' /tmp/api-cert.json");
  });
});
