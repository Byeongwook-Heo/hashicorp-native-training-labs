import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthService } from "../server/auth.js";
import { createStore } from "../server/store.js";

const catalog = {
  version: 2,
  updatedAt: "2026-07-26",
  tracks: [
    {
      id: "vault-basics",
      title: "Vault 기초",
      summary: "Vault 핵심 과정",
      level: "입문",
      durationMinutes: 30,
      delivery: "native",
      readiness: "active",
      outcomes: ["상태 확인"],
      requirements: [],
    },
  ],
};

const readCatalog = vi.fn();
const readCatalogYaml = vi.fn();
const writeCatalogYaml = vi.fn();

vi.mock("../server/catalog.js", () => ({
  readCatalog,
  readCatalogYaml,
  writeCatalogYaml,
}));

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let activeServer: http.Server | undefined;

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vault-content-"));
  const store = createStore({ filePath: path.join(directory, "store.json") });
  const auth = createAuthService(store, {
    cookieSecret: "content-router-test-secret-with-32-bytes-minimum",
    cookieSecure: false,
  });
  const admin = await auth.bootstrapAdminFromEnv({
    LAB_ADMIN_EMAIL: "admin@example.com",
    LAB_ADMIN_PASSWORD: "AdminPassword!123",
  });
  if (!admin) throw new Error("admin bootstrap failed");
  const adminLogin = await auth.login({
    email: "admin@example.com",
    password: "AdminPassword!123",
  });

  const cohort = await auth.createCohort(admin, { name: "Vault 교육" });
  const instructorInvite = await auth.createInvitation(admin, {
    role: "instructor",
    cohortId: cohort.id,
  });
  const instructor = await auth.enroll({
    inviteCode: instructorInvite.inviteCode,
    email: "instructor@example.com",
    displayName: "강사",
    password: "InstructorPassword!123",
  });
  const learnerInvite = await auth.createInvitation(admin, {
    role: "learner",
    cohortId: cohort.id,
  });
  const learner = await auth.enroll({
    inviteCode: learnerInvite.inviteCode,
    email: "learner@example.com",
    displayName: "교육생",
    password: "LearnerPassword!123",
  });

  const { createContentRouter } = await import("../server/content.js");
  const app = express();
  app.use(createContentRouter(auth));
  activeServer = http.createServer(app);
  await new Promise<void>((resolve) => activeServer!.listen(0, "127.0.0.1", resolve));
  const address = activeServer.address();
  if (!address || typeof address === "string") throw new Error("server failed");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cookie = (setCookie: string) => setCookie.split(";")[0];
  return {
    store,
    baseUrl,
    adminCookie: cookie(adminLogin.setCookie),
    instructorCookie: cookie(instructor.setCookie),
    learnerCookie: cookie(learner.setCookie),
  };
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  readCatalog.mockReset().mockResolvedValue(catalog);
  readCatalogYaml.mockReset().mockResolvedValue({
    catalog,
    yaml: "version: 2\n",
  });
  writeCatalogYaml.mockReset().mockResolvedValue(catalog);
});

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve, reject) =>
      activeServer!.close((error) => (error ? reject(error) : resolve())),
    );
    activeServer = undefined;
  }
});

describe("content router access", () => {
  it("requires login for the learner catalog", async () => {
    const fixture = await createFixture();
    const response = await fetch(`${fixture.baseUrl}/catalog`);
    expect(response.status).toBe(401);
  });

  it("returns public catalog data to a learner without YAML", async () => {
    const fixture = await createFixture();
    const response = await fetch(`${fixture.baseUrl}/catalog`, {
      headers: { Cookie: fixture.learnerCookie },
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ catalog });
  });

  it("allows instructors to read but not update admin catalog data", async () => {
    const fixture = await createFixture();
    const readResponse = await fetch(`${fixture.baseUrl}/admin/catalog`, {
      headers: { Cookie: fixture.instructorCookie },
    });
    expect(readResponse.status).toBe(200);
    expect(await json(readResponse)).toHaveProperty("yaml");

    const writeResponse = await fetch(`${fixture.baseUrl}/admin/catalog`, {
      method: "PUT",
      headers: {
        Cookie: fixture.instructorCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ yaml: "version: 2\n" }),
    });
    expect(writeResponse.status).toBe(403);
    expect(writeCatalogYaml).not.toHaveBeenCalled();
  });
});

describe("content router updates", () => {
  it("allows an admin update and records bounded audit metadata", async () => {
    const fixture = await createFixture();
    const yaml = "version: 2\nupdatedAt: 2026-07-26\ntracks: []\n";
    const response = await fetch(`${fixture.baseUrl}/admin/catalog`, {
      method: "PUT",
      headers: {
        Cookie: fixture.adminCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ yaml }),
    });
    expect(response.status).toBe(200);
    expect(writeCatalogYaml).toHaveBeenCalledWith(yaml);
    const events = await fixture.store.listAudit({ limit: 100 });
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["catalog.update_requested", "catalog.updated"]),
    );
    expect(JSON.stringify(events)).not.toContain(yaml);
  });

  it("rejects oversized JSON before the catalog writer", async () => {
    const fixture = await createFixture();
    const response = await fetch(`${fixture.baseUrl}/admin/catalog`, {
      method: "PUT",
      headers: {
        Cookie: fixture.adminCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ yaml: "x".repeat(270_000) }),
    });
    expect(response.status).toBe(413);
    expect(await json(response)).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(writeCatalogYaml).not.toHaveBeenCalled();
  });

  it("maps invalid catalog and storage failures to safe status codes", async () => {
    const fixture = await createFixture();
    writeCatalogYaml.mockRejectedValueOnce(new Error("private parser detail"));
    const invalid = await fetch(`${fixture.baseUrl}/admin/catalog`, {
      method: "PUT",
      headers: {
        Cookie: fixture.adminCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ yaml: "invalid: [" }),
    });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(await json(invalid))).not.toContain("private parser");

    const storageError = Object.assign(new Error("/secret/path denied"), {
      code: "EACCES",
    });
    writeCatalogYaml.mockRejectedValueOnce(storageError);
    const unavailable = await fetch(`${fixture.baseUrl}/admin/catalog`, {
      method: "PUT",
      headers: {
        Cookie: fixture.adminCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ yaml: "version: 2\n" }),
    });
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await json(unavailable))).not.toContain("/secret/path");
  });
});
