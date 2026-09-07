import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AuthError,
  createAuthService,
  hashPassword,
  sanitizeAuditMetadata,
  type AuthServiceOptions,
  verifyPassword,
} from "../server/auth.js";
import { createStore } from "../server/store.js";

const cookieSecret = "test-only-cookie-secret-with-at-least-32-bytes";

async function fixture(options: AuthServiceOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vault-lab-auth-"));
  const filePath = path.join(directory, "store.json");
  const store = createStore({ filePath });
  const auth = createAuthService(store, {
    cookieSecret,
    cookieSecure: true,
    touchIntervalMs: Number.POSITIVE_INFINITY,
    ...options,
  });
  const admin = await auth.bootstrapAdminFromEnv({
    LAB_ADMIN_EMAIL: "admin@example.com",
    LAB_ADMIN_PASSWORD: "AdminPassword!123",
    LAB_ADMIN_NAME: "관리자",
  });
  if (!admin) throw new Error("admin bootstrap failed");
  return { filePath, store, auth, admin };
}

describe("password hashing", () => {
  it("uses a salted scrypt representation", async () => {
    const first = await hashPassword("LearnerPassword!123");
    const second = await hashPassword("LearnerPassword!123");
    expect(first).not.toBe(second);
    await expect(verifyPassword("LearnerPassword!123", first)).resolves.toBe(
      true,
    );
    await expect(verifyPassword("wrong-password", first)).resolves.toBe(false);
  });
});

describe("auth and progress lifecycle", () => {
  it("enrolls by invitation, persists progress, and exposes cohort status", async () => {
    const { filePath, auth, admin } = await fixture();
    const cohort = await auth.createCohort(admin, {
      name: "7월 Vault 과정",
      courseId: "vault-foundations",
    });
    const { invite, inviteCode } = await auth.createInvitation(admin, {
      role: "learner",
      email: "learner@example.com",
      cohortId: cohort.id,
    });
    expect(invite).not.toHaveProperty("codeHash");

    const enrollment = await auth.enroll({
      inviteCode,
      email: "learner@example.com",
      displayName: "교육생",
      password: "LearnerPassword!123",
    });
    expect(enrollment.setCookie).toContain("HttpOnly");
    expect(enrollment.setCookie).toContain("SameSite=Strict");
    expect(enrollment.setCookie).toContain("Secure");

    const cookiePair = enrollment.setCookie.split(";")[0];
    const context = await auth.authenticateCookieHeader(cookiePair);
    expect(context?.user.email).toBe("learner@example.com");

    await auth.recordSkip(enrollment.user, "status");
    const passed = await auth.recordVerifiedPass(
      enrollment.user,
      "status",
      "vault-foundations",
      2,
    );
    expect(passed.status).toBe("passed");
    expect(passed.attempts).toBe(2);
    await auth.recordSkip(enrollment.user, "status");
    const progress = await auth.store.getProgress(
      enrollment.user.id,
      "vault-foundations",
    );
    expect(progress).toHaveLength(1);
    expect(progress[0].status).toBe("passed");

    const status = await auth.getCohortStatus(admin, cohort.id);
    expect(status).toMatchObject([
      {
        passed: 1,
        skipped: 0,
        attemptedSteps: 1,
      },
    ]);

    const persisted = await readFile(filePath, "utf8");
    expect(persisted).not.toContain(inviteCode);
    expect(persisted).not.toContain("LearnerPassword!123");
  });

  it("enforces invitation roles and account disablement", async () => {
    const { auth, admin } = await fixture();
    const cohort = await auth.createCohort(admin, { name: "강사 과정" });
    const { inviteCode } = await auth.createInvitation(admin, {
      role: "instructor",
      cohortId: cohort.id,
    });
    const instructor = await auth.enroll({
      inviteCode,
      email: "teacher@example.com",
      displayName: "강사",
      password: "TeacherPassword!123",
    });
    const visible = await auth.listCohorts(instructor.user);
    expect(visible.map((item) => item.id)).toContain(cohort.id);

    await expect(
      auth.createInvitation(instructor.user, { role: "admin" }),
    ).rejects.toMatchObject({ status: 403 });

    const cookiePair = instructor.setCookie.split(";")[0];
    await auth.setUserStatus(admin, instructor.user.id, "disabled");
    await expect(auth.authenticateCookieHeader(cookiePair)).resolves.toBeUndefined();
    await expect(
      auth.login({
        email: "teacher@example.com",
        password: "TeacherPassword!123",
      }),
    ).rejects.toMatchObject({ code: "USER_DISABLED" });
  });

  it("rejects unknown roles at the service boundary", async () => {
    const { auth, admin } = await fixture();
    await expect(
      auth.createInvitation(admin, {
        role: "owner" as "admin",
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("authentication session bounds", () => {
  it("evicts the oldest session when a user reaches the active-session cap", async () => {
    const { auth, store } = await fixture({
      maxActiveSessionsPerUser: 2,
    });
    const events: Array<{ sessionId: string; reason: string }> = [];
    auth.onSessionRevoked((event) =>
      events.push({ sessionId: event.sessionId, reason: event.reason }),
    );

    const first = await auth.login({
      email: "admin@example.com",
      password: "AdminPassword!123",
    });
    const second = await auth.login({
      email: "admin@example.com",
      password: "AdminPassword!123",
    });
    const third = await auth.login({
      email: "admin@example.com",
      password: "AdminPassword!123",
    });

    await expect(
      auth.authenticateCookieHeader(first.setCookie.split(";")[0]),
    ).resolves.toBeUndefined();
    await expect(
      auth.authenticateCookieHeader(second.setCookie.split(";")[0]),
    ).resolves.toMatchObject({ sessionId: second.sessionId });
    await expect(
      auth.authenticateCookieHeader(third.setCookie.split(";")[0]),
    ).resolves.toMatchObject({ sessionId: third.sessionId });

    const snapshot = await store.snapshot();
    expect(
      snapshot.sessions.filter((session) => !session.revokedAt),
    ).toHaveLength(2);
    expect(events).toContainEqual({
      sessionId: first.sessionId,
      reason: "session-limit",
    });
    auth.stop();
  });

  it("prunes expired sessions and emits an expiry notification", async () => {
    const { auth, store } = await fixture();
    const login = await auth.login({
      email: "admin@example.com",
      password: "AdminPassword!123",
    });
    const events: Array<{ sessionId: string; reason: string }> = [];
    auth.onSessionRevoked((event) =>
      events.push({ sessionId: event.sessionId, reason: event.reason }),
    );
    await store.transaction((data) => {
      const session = data.sessions.find(
        (candidate) => candidate.id === login.sessionId,
      );
      if (!session) throw new Error("test session missing");
      session.expiresAt = new Date(Date.now() - 1_000).toISOString();
    });

    await expect(auth.pruneExpiredSessions()).resolves.toBe(1);
    await expect(store.getSession(login.sessionId)).resolves.toBeUndefined();
    expect(events).toContainEqual({
      sessionId: login.sessionId,
      reason: "expired",
    });
    auth.stop();
  });
});

describe("audit redaction", () => {
  it("redacts nested credentials", () => {
    expect(
      sanitizeAuditMetadata({
        email: "user@example.com",
        nested: { accessToken: "secret-value", ok: true },
      }),
    ).toEqual({
      email: "user@example.com",
      nested: { accessToken: "[REDACTED]", ok: true },
    });
  });
});
