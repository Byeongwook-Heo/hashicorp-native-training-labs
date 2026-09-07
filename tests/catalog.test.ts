import { describe, expect, it } from "vitest";
import { readCatalog, validateCatalog } from "../server/catalog.js";

const validCatalog = {
  version: 1,
  updatedAt: "2026-07-26",
  tracks: [{
    id: "vault-basics",
    title: "Vault 기초",
    summary: "안전한 교육 과정",
    level: "입문",
    durationMinutes: 30,
    delivery: "native",
    readiness: "active",
    outcomes: ["상태 확인"],
    requirements: []
  }]
};

describe("course catalog validation", () => {
  it("accepts a bounded native course", () => {
    expect(validateCatalog(validCatalog).tracks[0].id).toBe("vault-basics");
  });

  it("rejects duplicate track ids", () => {
    expect(() => validateCatalog({
      ...validCatalog,
      tracks: [validCatalog.tracks[0], validCatalog.tracks[0]]
    })).toThrow(/중복/);
  });

  it("rejects unknown delivery modes", () => {
    expect(() => validateCatalog({
      ...validCatalog,
      tracks: [{ ...validCatalog.tracks[0], delivery: "container" }]
    })).toThrow(/delivery/);
  });

  it("publishes the 30-stage Vault 2.x native track without unimplemented claims", async () => {
    const catalog = await readCatalog();
    const foundations = catalog.tracks.find((track) => track.id === "vault-foundations");
    const operations = catalog.tracks.find((track) => track.id === "operations-and-audit");
    const pki = catalog.tracks.find((track) => track.id === "pki-secrets-engine");

    expect(catalog.version).toBeGreaterThanOrEqual(2);
    expect(foundations?.summary).toContain("30개 검증 단계");
    expect(foundations?.summary).toContain("Vault 2.x");
    expect(foundations?.requirements).toEqual(expect.arrayContaining([
      "Vault 2.x CLI",
      "jq",
      "openssl"
    ]));
    expect(operations?.summary).toContain("Token accessor");
    expect(operations?.summary).not.toContain("응답 래핑");
    expect(pki?.outcomes.join(" ")).toContain("Private Key 일치");
    expect(pki?.outcomes.join(" ")).not.toContain("CRL");
  });

  it("publishes the isolated 34-stage Terraform native track", async () => {
    const catalog = await readCatalog();
    const terraform = catalog.tracks.find((track) => track.id === "terraform-foundations");

    expect(catalog.version).toBeGreaterThanOrEqual(3);
    expect(terraform).toMatchObject({
      readiness: "active",
      delivery: "dedicated",
      durationMinutes: 225
    });
    expect(terraform?.summary).toContain("34개 서버 검증 단계");
    expect(terraform?.summary).toContain("state·drift");
    expect(terraform?.summary).toContain("Agent Skills");
    expect(terraform?.requirements).toEqual(expect.arrayContaining([
      "Terraform 1.15.8 CLI",
      "root-owned offline provider mirror",
      "root-owned HashiCorp Agent Skills Unreleased main commit snapshot",
      "jq"
    ]));
    expect(terraform?.outcomes.join(" ")).toContain("제한된 destroy");
    expect(terraform?.outcomes.join(" ")).toContain("Agent Skills");
  });
});
