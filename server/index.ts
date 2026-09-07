import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  createAuthRouter,
  createAuthService,
  getAuthContext
} from "./auth.js";
import { createContentRouter } from "./content.js";
import {
  createCourseRuntime,
  resolveCourseDefinition
} from "./course-registry.js";
import {
  publicCourseDefinition,
  type LabSessionInfo
} from "./course-definition.js";
import type { Step } from "./curriculum.js";
import {
  NativeRuntimeError,
  isExactVerifierResult,
  type NativeCommandResult,
  type NativeTerminalChannel
} from "./native-runtime.js";
import { createRateLimiter } from "./rate-limit.js";
import { createStore, type PublicUser, type StoreData } from "./store.js";
import { containsTerminalExecution } from "./terminal-input.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MOCK_LAB = process.env.MOCK_LAB === "true";
const course = resolveCourseDefinition();
const publicCourse = publicCourseDefinition(course);
const steps = course.steps;
const SESSION_LIMIT = Number(process.env.MAX_SESSIONS || 4);
const LAB_OPERATION_LIMIT = Number(
  process.env.MAX_CONCURRENT_LAB_OPERATIONS || Math.min(8, SESSION_LIMIT)
);
const WS_INPUT_BYTES_PER_SECOND = Number(
  process.env.WS_INPUT_BYTES_PER_SECOND || 128 * 1024
);
const WS_INPUT_BURST_BYTES = Number(
  process.env.WS_INPUT_BURST_BYTES || 256 * 1024
);
const AUTH_SECRET = process.env.AUTH_COOKIE_SECRET
  ?? (MOCK_LAB ? "mock-only-auth-cookie-secret-2026-change-me" : "");
const SESSION_SECRET = process.env.LAB_SESSION_SECRET || AUTH_SECRET;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) throw new Error("PORT 값이 올바르지 않습니다.");
if (!HOST.trim() || HOST.includes("\u0000")) throw new Error("HOST 값이 올바르지 않습니다.");
if (!Number.isInteger(SESSION_LIMIT) || SESSION_LIMIT < 1 || SESSION_LIMIT > 99) {
  throw new Error("MAX_SESSIONS는 1 이상 99 이하의 정수여야 합니다.");
}
if (
  !Number.isInteger(LAB_OPERATION_LIMIT)
  || LAB_OPERATION_LIMIT < 1
  || LAB_OPERATION_LIMIT > 64
) {
  throw new Error("MAX_CONCURRENT_LAB_OPERATIONS는 1 이상 64 이하의 정수여야 합니다.");
}
if (
  !Number.isInteger(WS_INPUT_BYTES_PER_SECOND)
  || WS_INPUT_BYTES_PER_SECOND < 1_024
  || WS_INPUT_BYTES_PER_SECOND > 4 * 1024 * 1024
) {
  throw new Error("WS_INPUT_BYTES_PER_SECOND는 1024부터 4194304 사이의 정수여야 합니다.");
}
if (
  !Number.isInteger(WS_INPUT_BURST_BYTES)
  || WS_INPUT_BURST_BYTES < 1_024
  || WS_INPUT_BURST_BYTES > 4 * 1024 * 1024
) {
  throw new Error("WS_INPUT_BURST_BYTES는 1024부터 4194304 사이의 정수여야 합니다.");
}
if (!AUTH_SECRET || Buffer.byteLength(AUTH_SECRET) < 32) {
  throw new Error("AUTH_COOKIE_SECRET은 32바이트 이상의 값이어야 합니다.");
}
if (Buffer.byteLength(SESSION_SECRET) < 32) {
  throw new Error("LAB_SESSION_SECRET은 32바이트 이상의 값이어야 합니다.");
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use((request, response, next) => {
  const requestId = request.get("x-request-id")?.slice(0, 80) || crypto.randomUUID();
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (request.path.startsWith("/api/")) response.setHeader("cache-control", "no-store");
  next();
});

const apiLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.API_RATE_LIMIT_PER_MINUTE || 600),
  maxKeys: 10_000,
  message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."
});
const validationLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.VALIDATION_RATE_LIMIT_PER_MINUTE || 60),
  maxKeys: Math.max(1_000, SESSION_LIMIT * 20),
  key: (request, response) => {
    const context = getAuthContext(response);
    return context ? `user:${context.user.id}` : `ip:${request.ip}`;
  },
  message: "단계 검증 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."
});
const resetLimiter = createRateLimiter({
  windowMs: 10 * 60_000,
  max: Number(process.env.RESET_RATE_LIMIT_PER_10_MINUTES || 3),
  maxKeys: Math.max(1_000, SESSION_LIMIT * 20),
  key: (request, response) => {
    const context = getAuthContext(response);
    return context ? `user:${context.user.id}` : `ip:${request.ip}`;
  },
  message: "세션 초기화 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."
});
const adminSessionLimiter = createRateLimiter({
  windowMs: 5 * 60_000,
  max: Number(process.env.ADMIN_SESSION_RATE_LIMIT_PER_5_MINUTES || 30),
  maxKeys: 1_000,
  key: (request, response) => {
    const context = getAuthContext(response);
    return context ? `user:${context.user.id}` : `ip:${request.ip}`;
  },
  message: "세션 관리 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."
});
app.use("/api", apiLimiter.middleware);
app.use((request, response, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  const origin = request.get("origin");
  if (!origin) return next();
  try {
    if (new URL(origin).host !== request.get("host")) {
      response.status(403).json({ error: "허용되지 않은 요청 출처입니다.", code: "ORIGIN_REJECTED" });
      return;
    }
  } catch {
    response.status(403).json({ error: "요청 출처가 올바르지 않습니다.", code: "ORIGIN_REJECTED" });
    return;
  }
  next();
});

const store = createStore();
const auth = createAuthService(store, {
  cookieSecret: AUTH_SECRET,
  courseId: course.id
});
const runtime = createCourseRuntime(course, {
  mock: MOCK_LAB,
  maxSessions: SESSION_LIMIT
});
const authRouter = createAuthRouter(auth);

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

function sessionIdForUser(userId: string) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`lab:${course.id}:${userId}`)
    .digest("hex")
    .slice(0, 32);
}

function publicSteps() {
  return steps.map(({
    validate: _validate,
    expect: _expect,
    skipSetup: _skipSetup,
    ...step
  }) => step);
}

function progressSummary(data: Awaited<ReturnType<typeof store.getProgress>>) {
  return {
    passedStepIds: data.filter((item) => item.status === "passed").map((item) => item.stepId),
    skippedStepIds: data.filter((item) => item.status === "skipped").map((item) => item.stepId)
  };
}

async function requirePriorSteps(user: PublicUser, stepIndex: number) {
  const progress = await store.getProgress(user.id, course.id);
  const resolved = new Set(progress.map((item) => item.stepId));
  return steps.slice(0, stepIndex).find((item) => !resolved.has(item.id));
}

function runtimeStatus(error: unknown) {
  if (!(error instanceof NativeRuntimeError)) return 500;
  if (error.code === "INVALID_SESSION") return 400;
  if (error.code === "CAPACITY" || error.code === "SESSION_UNAVAILABLE" || error.code === "RUNTIME_MISCONFIGURED") {
    return 503;
  }
  return 500;
}

function pathParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function validationChecks(step: Step, result: NativeCommandResult) {
  const commandOk = result.code === 0 && !result.truncated;
  const markerOk = isExactVerifierResult(step.id, result);
  return [
    {
      label: "검증 명령 실행",
      ok: commandOk,
      detail: result.truncated
        ? "출력이 안전 제한을 초과했습니다."
        : result.code === 0
          ? "정상 종료"
          : `종료 코드 ${result.code}`
    },
    {
      label: "정확한 성공 증명",
      ok: commandOk && markerOk,
      detail: commandOk && markerOk
        ? "서버 검증기가 정확한 단계 성공 마커를 반환했습니다."
        : "현재 상태가 이 단계의 모든 성공 조건과 정확히 일치하지 않습니다."
    }
  ];
}

const activeLabOperations = new Set<string>();

function acquireLabOperation(
  response: Response,
  userId: string
): (() => void) | undefined {
  if (activeLabOperations.has(userId)) {
    response.status(409).json({
      error: "이 실습 세션에서 다른 작업이 진행 중입니다.",
      code: "LAB_OPERATION_IN_PROGRESS"
    });
    return undefined;
  }
  if (activeLabOperations.size >= LAB_OPERATION_LIMIT) {
    response.status(503).json({
      error: "실습 작업이 많습니다. 잠시 후 다시 시도해 주세요.",
      code: "LAB_OPERATION_CAPACITY"
    });
    return undefined;
  }
  activeLabOperations.add(userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLabOperations.delete(userId);
  };
}

async function clearProgress(userId: string) {
  await store.transaction((data) => {
    data.progress = data.progress.filter(
      (item) => !(item.userId === userId && item.courseId === course.id)
    );
  });
}

async function recordAudit(
  action: string,
  actor: PublicUser,
  targetType: string,
  targetId: string,
  metadata?: Record<string, unknown>
) {
  await store.appendAudit({
    action,
    actorUserId: actor.id,
    targetType,
    targetId,
    metadata: { courseId: course.id, ...metadata }
  });
}

app.get("/healthz", (_request, response) => {
  response.json({
    ok: true,
    runtime: MOCK_LAB ? "mock" : "native",
    runtimeKind: course.runtimeKind,
    courseId: course.id,
    version: process.env.APP_COMMIT_SHA || "development"
  });
});

app.get("/api/course", (_request, response) => {
  response.json({
    course: publicCourse,
    labs: course.labs
  });
});

// This route intentionally precedes the generic auth router so skip progression is
// checked against the server-side curriculum rather than trusted browser state.
app.post(
  "/api/auth/progress/:stepId/skip",
  auth.authenticate,
  auth.requireAuth,
  validationLimiter.middleware,
  asyncRoute(async (request, response) => {
    const context = getAuthContext(response)!;
    const index = steps.findIndex((item) => item.id === request.params.stepId);
    if (index < 0) {
      response.status(404).json({ error: "단계를 찾을 수 없습니다.", code: "STEP_NOT_FOUND" });
      return;
    }
    const missing = await requirePriorSteps(context.user, index);
    if (missing) {
      response.status(409).json({
        error: `먼저 “${missing.title}” 단계를 성공하거나 스킵해야 합니다.`,
        code: "PREVIOUS_STEP_REQUIRED"
      });
      return;
    }
    const step = steps[index];
    const release = acquireLabOperation(response, context.user.id);
    if (!release) return;
    try {
      const id = sessionIdForUser(context.user.id);
      const setup = await runtime.execute(id, step.skipSetup, {
        operation: "skip",
        stepId: step.id
      });
      if (setup.code !== 0 || setup.truncated) {
        await recordAudit(
          "progress.skip_setup_failed",
          context.user,
          "step",
          step.id,
          { exitCode: setup.code, truncated: setup.truncated }
        ).catch(() => undefined);
        response.status(409).json({
          error: "다음 단계 준비에 실패해 이 단계를 스킵하지 않았습니다.",
          code: "SKIP_SETUP_FAILED"
        });
        return;
      }
      const progress = await auth.recordSkip(
        context.user,
        step.id,
        course.id
      );
      response.json({ progress });
    } catch (error) {
      await recordAudit(
        "progress.skip_setup_error",
        context.user,
        "step",
        step.id,
        {
          errorCode:
            error instanceof NativeRuntimeError ? error.code : "INTERNAL"
        }
      ).catch(() => undefined);
      response.status(runtimeStatus(error)).json({
        error: "다음 단계 준비 중 오류가 발생해 이 단계를 스킵하지 않았습니다.",
        code: "SKIP_SETUP_ERROR"
      });
    } finally {
      release();
    }
  })
);

app.post(
  "/api/auth/users/:userId/status",
  express.json({ limit: "8kb" }),
  auth.authenticate,
  auth.requireRole("admin"),
  adminSessionLimiter.middleware,
  asyncRoute(async (request, response) => {
    const actor = getAuthContext(response)!.user;
    const status = request.body?.status;
    if (status !== "active" && status !== "disabled") {
      response.status(400).json({ error: "status는 active 또는 disabled여야 합니다." });
      return;
    }
    const user = await auth.setUserStatus(
      actor,
      pathParam(request.params.userId),
      status
    );
    if (status === "disabled") {
      await runtime.destroy(sessionIdForUser(user.id)).catch(() => undefined);
    }
    response.json({ user });
  })
);

app.use("/api/auth", authRouter.router);
app.use("/api/content", createContentRouter(auth));

app.get(
  "/api/session",
  auth.authenticate,
  auth.requireAuth,
  asyncRoute(async (_request, response) => {
    const context = getAuthContext(response)!;
    const id = sessionIdForUser(context.user.id);
    try {
      const [session, progress] = await Promise.all([
        runtime.getOrCreate(id),
        store.getProgress(context.user.id, course.id)
      ]);
      response.json({
        id,
        ready: true,
        expiresAt: session.expiresAt,
        course: publicCourse,
        labs: course.labs,
        steps: publicSteps(),
        progress: progressSummary(progress)
      });
    } catch (error) {
      response.status(runtimeStatus(error)).json({
        id,
        ready: false,
        course: publicCourse,
        labs: course.labs,
        error: (error as Error).message
      });
    }
  })
);

app.post(
  "/api/validate/:stepId",
  auth.authenticate,
  auth.requireAuth,
  validationLimiter.middleware,
  asyncRoute(async (request, response) => {
    const context = getAuthContext(response)!;
    const index = steps.findIndex((item) => item.id === request.params.stepId);
    if (index < 0) {
      response.status(404).json({ ok: false, message: "단계를 찾을 수 없습니다." });
      return;
    }
    const missing = await requirePriorSteps(context.user, index);
    if (missing) {
      response.status(409).json({
        ok: false,
        message: `먼저 “${missing.title}” 단계를 성공하거나 스킵해야 합니다.`
      });
      return;
    }
    const step = steps[index];
    const id = sessionIdForUser(context.user.id);
    const release = acquireLabOperation(response, context.user.id);
    if (!release) return;
    try {
      const result = await runtime.execute(id, step.validate, {
        operation: "verify",
        stepId: step.id
      });
      const effectiveResult =
        MOCK_LAB && result.code === 0 && !result.truncated
          ? {
              ...result,
              stdout: `verified:${step.id}\n`,
              output: `verified:${step.id}\n`
            }
          : result;
      const checks = validationChecks(step, effectiveResult);
      const ok = checks.every((check) => check.ok);
      if (ok) {
        await auth.recordVerifiedPass(context.user, step.id, course.id);
      } else {
        await recordAudit("validation.failed", context.user, "step", step.id, {
          failedChecks: checks.filter((check) => !check.ok).map((check) => check.label),
          exitCode: effectiveResult.code,
          truncated: effectiveResult.truncated
        });
      }
      response.json({
        ok,
        checks,
        message: ok
          ? step.success
          : course.copy.validationFailure
      });
    } catch (error) {
      await recordAudit("validation.error", context.user, "step", step.id, {
        errorCode: error instanceof NativeRuntimeError ? error.code : "INTERNAL"
      }).catch(() => undefined);
      response.status(runtimeStatus(error)).json({ ok: false, message: (error as Error).message });
    } finally {
      release();
    }
  })
);

app.post(
  "/api/reset",
  auth.authenticate,
  auth.requireAuth,
  resetLimiter.middleware,
  asyncRoute(async (_request, response) => {
    const context = getAuthContext(response)!;
    const id = sessionIdForUser(context.user.id);
    const release = acquireLabOperation(response, context.user.id);
    if (!release) return;
    try {
      const session = await runtime.reset(id);
      await clearProgress(context.user.id);
      await recordAudit("session.reset", context.user, "session", id);
      response.json({ ok: true, expiresAt: session.expiresAt });
    } catch (error) {
      response.status(runtimeStatus(error)).json({ ok: false, error: (error as Error).message });
    } finally {
      release();
    }
  })
);

function visibleLearners(actor: PublicUser, data: StoreData) {
  if (actor.role === "admin") return data.users.filter((user) => user.role === "learner");
  const cohortIds = new Set(
    data.cohorts
      .filter((cohort) => !cohort.archivedAt && cohort.instructorIds.includes(actor.id))
      .map((cohort) => cohort.id)
  );
  return data.users.filter((user) =>
    user.role === "learner" && user.cohortIds.some((id) => cohortIds.has(id))
  );
}

async function authorizeManagedSession(actor: PublicUser, sessionId: string) {
  const snapshot = await store.snapshot();
  const learner = visibleLearners(actor, snapshot)
    .find((candidate) => sessionIdForUser(candidate.id) === sessionId);
  if (!learner) {
    const error = new Error("이 실습 세션을 관리할 권한이 없습니다.");
    Object.assign(error, { status: 403 });
    throw error;
  }
  return learner;
}

app.get(
  "/api/admin/overview",
  auth.authenticate,
  auth.requireRole("admin", "instructor"),
  asyncRoute(async (_request, response) => {
    const actor = getAuthContext(response)!.user;
    const snapshot = await store.snapshot();
    const learners = visibleLearners(actor, snapshot);
    const visibleCohortIds = new Set(learners.flatMap((learner) => learner.cohortIds));
    const cohorts = snapshot.cohorts
      .filter((cohort) => visibleCohortIds.has(cohort.id) || actor.role === "admin")
      .filter((cohort) => !cohort.archivedAt)
      .map((cohort) => ({
        id: cohort.id,
        name: cohort.name,
        courseName:
          !cohort.courseId || cohort.courseId === course.id
            ? course.title
            : cohort.courseId
      }));
    if (learners.some((learner) => learner.cohortIds.length === 0)) {
      cohorts.push({
        id: "unassigned",
        name: "미배정 교육생",
        courseName: course.title
      });
    }
    const learnerRows = await Promise.all(learners.map(async (learner) => {
      const sessionId = sessionIdForUser(learner.id);
      const session = await runtime.get(sessionId).catch(() => null);
      const progress = snapshot.progress.filter((item) =>
        item.userId === learner.id && item.courseId === course.id
      );
      const lastAuthSession = snapshot.sessions
        .filter((item) => item.userId === learner.id && !item.revokedAt)
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
      return {
        id: learner.id,
        name: learner.displayName,
        email: learner.email,
        status: learner.status,
        cohortId: learner.cohortIds[0] || "unassigned",
        cohortName: snapshot.cohorts.find((cohort) => cohort.id === learner.cohortIds[0])?.name || "미배정",
        progress: {
          completed: progress.filter((item) => item.status === "passed").length,
          skipped: progress.filter((item) => item.status === "skipped").length,
          total: steps.length
        },
        failedAttempts: snapshot.auditEvents.filter((event) =>
          event.actorUserId === learner.id && event.action === "validation.failed"
        ).length,
        session: session ? {
          id: sessionId,
          status: "active" as const,
          createdAt: new Date(session.createdAt).toISOString(),
          expiresAt: new Date(session.expiresAt).toISOString(),
          lastActiveAt: lastAuthSession?.lastSeenAt
        } : null
      };
    }));
    response.json({ cohorts, learners: learnerRows });
  })
);

app.post(
  "/api/admin/sessions/:sessionId/:action",
  express.json({ limit: "8kb" }),
  auth.authenticate,
  auth.requireRole("admin", "instructor"),
  adminSessionLimiter.middleware,
  asyncRoute(async (request, response) => {
    const actor = getAuthContext(response)!.user;
    const sessionId = pathParam(request.params.sessionId);
    const action = pathParam(request.params.action);
    const learner = await authorizeManagedSession(actor, sessionId);
    if (!["reset", "extend", "end"].includes(action)) {
      response.status(404).json({ error: "지원하지 않는 세션 작업입니다." });
      return;
    }
    const minutes = action === "extend"
      ? Number(request.body?.minutes || 60)
      : 0;
    if (
      action === "extend"
      && (!Number.isInteger(minutes) || minutes < 5 || minutes > 240)
    ) {
      response.status(400).json({ error: "연장 시간은 5~240분 사이여야 합니다." });
      return;
    }
    const release = acquireLabOperation(response, learner.id);
    if (!release) return;
    try {
      let session: LabSessionInfo | null = null;
      if (action === "reset") {
        session = await runtime.reset(sessionId);
        await clearProgress(learner.id);
      } else if (action === "extend") {
        session = await runtime.extend(sessionId, minutes * 60_000);
      } else {
        await runtime.destroy(sessionId);
      }
      await recordAudit(`session.${action}`, actor, "session", sessionId, {
        learnerId: learner.id,
        expiresAt: session?.expiresAt
      });
      response.json({
        ok: true,
        session: session ? {
          id: session.id,
          expiresAt: new Date(session.expiresAt).toISOString()
        } : null
      });
    } finally {
      release();
    }
  })
);

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "API 경로를 찾을 수 없습니다.", code: "NOT_FOUND" });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, "../dist");
app.use(express.static(staticDir, {
  etag: true,
  setHeaders(response, file) {
    if (file.includes(`${path.sep}assets${path.sep}`)) {
      response.setHeader("cache-control", "public, max-age=31536000, immutable");
    }
  }
}));
app.get("*splat", (request, response, next) => {
  if (!request.accepts("html")) return next();
  response.setHeader("cache-control", "no-cache");
  response.sendFile(path.join(staticDir, "index.html"));
});

app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? Number((error as { status: number }).status)
    : 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const requestId = String(response.getHeader("x-request-id") || "");
  console.error("Request failed", {
    requestId,
    method: request.method,
    path: request.path,
    status: safeStatus,
    error: (error as Error).message
  });
  if (response.headersSent) return;
  response.status(safeStatus).json({
    error: safeStatus >= 500 ? "서버 요청을 처리하지 못했습니다." : (error as Error).message,
    code: safeStatus >= 500 ? "INTERNAL_ERROR" : "REQUEST_REJECTED",
    requestId
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/terminal",
  maxPayload: 64 * 1024,
  perMessageDeflate: false
});
const activeTerminalByUser = new Map<string, WebSocket>();
const aliveSockets = new WeakMap<WebSocket, boolean>();
const WS_OUTPUT_LOW_WATER = 128 * 1024;
const WS_OUTPUT_SOFT_LIMIT = 512 * 1024;
const WS_OUTPUT_HARD_LIMIT = 2 * 1024 * 1024;
const WS_INPUT_QUEUE_LIMIT = 256 * 1024;
const WS_PENDING_AUTH_LIMIT = Math.max(16, SESSION_LIMIT * 4);
const WS_ACTIVE_LIMIT = SESSION_LIMIT;

type TerminalSocketState = {
  userId: string;
  authSessionId: string;
  terminal?: NativeTerminalChannel;
  inputTokens: number;
  inputRefillAt: number;
  inputQueue: Buffer[];
  inputQueuedBytes: number;
  inputBlocked: boolean;
  outputPaused: boolean;
  outputListener?: (data: Buffer) => void;
  errorOutputListener?: (data: Buffer) => void;
  drainTimer?: NodeJS.Timeout;
  release?: () => void;
};

const terminalSockets = new Map<WebSocket, TerminalSocketState>();

function rawDataBuffer(data: RawData) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function validWebSocketOrigin(request: http.IncomingMessage) {
  const origin = request.headers.origin;
  if (!origin) return MOCK_LAB;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.host === request.headers.host
    );
  } catch {
    return false;
  }
}

function closeTerminalSocket(ws: WebSocket, code: number, reason: string) {
  terminalSockets.get(ws)?.terminal?.close();
  if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
  else if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
}

function pauseTerminalOutput(
  state: TerminalSocketState,
  paused: boolean
) {
  if (!state.terminal || state.outputPaused === paused) return;
  state.outputPaused = paused;
  for (const stream of [
    state.terminal.output,
    state.terminal.errorOutput
  ]) {
    if (paused) stream.pause();
    else stream.resume();
  }
}

function monitorSocketDrain(ws: WebSocket, state: TerminalSocketState) {
  if (state.drainTimer) return;
  state.drainTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(state.drainTimer);
      state.drainTimer = undefined;
      return;
    }
    if (ws.bufferedAmount > WS_OUTPUT_HARD_LIMIT) {
      closeTerminalSocket(ws, 4429, "Terminal output backpressure");
      return;
    }
    if (ws.bufferedAmount <= WS_OUTPUT_LOW_WATER) {
      pauseTerminalOutput(state, false);
      clearInterval(state.drainTimer);
      state.drainTimer = undefined;
    }
  }, 50);
  state.drainTimer.unref();
}

function sendTerminalData(
  ws: WebSocket,
  data: Buffer | string
): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const state = terminalSockets.get(ws);
  if (!state) return false;
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  if (ws.bufferedAmount + bytes > WS_OUTPUT_HARD_LIMIT) {
    closeTerminalSocket(ws, 4429, "Terminal output backpressure");
    return false;
  }
  try {
    ws.send(data, (error) => {
      if (error) closeTerminalSocket(ws, 1011, "Terminal transport failed");
    });
  } catch {
    closeTerminalSocket(ws, 1011, "Terminal transport failed");
    return false;
  }
  if (ws.bufferedAmount >= WS_OUTPUT_SOFT_LIMIT) {
    pauseTerminalOutput(state, true);
    monitorSocketDrain(ws, state);
  }
  return true;
}

function consumeInputBudget(state: TerminalSocketState, bytes: number) {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, now - state.inputRefillAt) / 1_000;
  state.inputTokens = Math.min(
    WS_INPUT_BURST_BYTES,
    state.inputTokens + elapsedSeconds * WS_INPUT_BYTES_PER_SECOND
  );
  state.inputRefillAt = now;
  if (bytes > state.inputTokens) return false;
  state.inputTokens -= bytes;
  return true;
}

function queueTerminalInput(
  ws: WebSocket,
  state: TerminalSocketState,
  data: Buffer
) {
  if (state.inputQueuedBytes + data.length > WS_INPUT_QUEUE_LIMIT) {
    closeTerminalSocket(ws, 4429, "Terminal input backpressure");
    return;
  }
  state.inputQueue.push(data);
  state.inputQueuedBytes += data.length;
}

function flushTerminalInput(ws: WebSocket, state: TerminalSocketState) {
  const terminal = state.terminal;
  if (!terminal || state.inputBlocked || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  while (state.inputQueue.length > 0) {
    const data = state.inputQueue.shift()!;
    state.inputQueuedBytes -= data.length;
    try {
      // A false return means the chunk was accepted but the Writable has
      // reached its high-water mark. Wait for drain before accepting more.
      if (!terminal.write(data)) {
        state.inputBlocked = true;
        return;
      }
    } catch {
      closeTerminalSocket(ws, 1011, "Terminal input failed");
      return;
    }
  }
}

const unsubscribeSessionRevocations = auth.onSessionRevoked((event) => {
  for (const [ws, state] of terminalSockets) {
    if (state.authSessionId === event.sessionId) {
      closeTerminalSocket(ws, 4401, "Authentication session ended");
    }
  }
});

let pendingTerminalAuthentications = 0;
wss.on("connection", async (ws, request) => {
  if (!validWebSocketOrigin(request)) {
    ws.close(4403, "Origin rejected");
    return;
  }
  if (pendingTerminalAuthentications >= WS_PENDING_AUTH_LIMIT) {
    ws.close(4429, "Too many terminal handshakes");
    return;
  }
  pendingTerminalAuthentications += 1;
  const context = await auth
    .authenticateCookieHeader(request.headers.cookie)
    .catch(() => undefined)
    .finally(() => {
      pendingTerminalAuthentications -= 1;
    });
  if (!context) {
    ws.close(4401, "Authentication required");
    return;
  }
  const userId = context.user.id;
  const existingSocket = activeTerminalByUser.get(userId);
  if (existingSocket) {
    terminalSockets.get(existingSocket)?.release?.();
    if (existingSocket.readyState === WebSocket.OPEN) {
      existingSocket.close(4410, "Terminal opened elsewhere");
    } else if (existingSocket.readyState !== WebSocket.CLOSED) {
      existingSocket.terminate();
    }
  }
  if (terminalSockets.size >= WS_ACTIVE_LIMIT) {
    ws.close(4429, "Terminal capacity reached");
    return;
  }
  const state: TerminalSocketState = {
    userId,
    authSessionId: context.sessionId,
    inputTokens: WS_INPUT_BURST_BYTES,
    inputRefillAt: Date.now(),
    inputQueue: [],
    inputQueuedBytes: 0,
    inputBlocked: false,
    outputPaused: false
  };
  terminalSockets.set(ws, state);
  activeTerminalByUser.set(userId, ws);
  aliveSockets.set(ws, true);
  ws.on("pong", () => aliveSockets.set(ws, true));
  ws.on("error", () => {
    state.terminal?.close();
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (state.drainTimer) clearInterval(state.drainTimer);
    if (state.terminal && state.outputListener) {
      state.terminal.output.off("data", state.outputListener);
    }
    if (state.terminal && state.errorOutputListener) {
      state.terminal.errorOutput.off("data", state.errorOutputListener);
    }
    state.terminal?.close();
    terminalSockets.delete(ws);
    if (activeTerminalByUser.get(userId) === ws) {
      activeTerminalByUser.delete(userId);
    }
  };
  state.release = release;
  ws.once("close", release);

  if (MOCK_LAB) {
    sendTerminalData(
      ws,
      Buffer.from(
        `\r\n\x1b[35m${course.copy.mockTerminalBanner}\x1b[0m\r\n${course.copy.terminalPrompt}`
      )
    );
    ws.on("message", (data) => {
      const buffer = rawDataBuffer(data);
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!consumeInputBudget(state, buffer.length)) {
        closeTerminalSocket(ws, 4429, "Terminal input rate exceeded");
        return;
      }
      const input = buffer.toString("utf8");
      const displayText = input.replace(/\u0015/g, "\r\x1b[K");
      sendTerminalData(ws, Buffer.from(displayText));
      if (containsTerminalExecution(input)) {
        sendTerminalData(
          ws,
          Buffer.from(
            `\r\nmock: 명령 입력을 확인했습니다.\r\n${course.copy.terminalPrompt}`
          )
        );
      }
    });
    return;
  }

  ws.on("message", (data) => {
    const buffer = rawDataBuffer(data);
    if (!consumeInputBudget(state, buffer.length)) {
      closeTerminalSocket(ws, 4429, "Terminal input rate exceeded");
      return;
    }
    if (!state.terminal || state.inputBlocked) {
      queueTerminalInput(ws, state, buffer);
      return;
    }
    try {
      if (!state.terminal.write(buffer)) state.inputBlocked = true;
    } catch {
      closeTerminalSocket(ws, 1011, "Terminal input failed");
    }
  });

  try {
    if (!runtime.openTerminal) {
      throw new Error(`${course.title} 런타임은 웹 터미널을 지원하지 않습니다.`);
    }
    const terminal = await runtime.openTerminal(sessionIdForUser(userId));
    if (
      ws.readyState !== WebSocket.OPEN
      || terminalSockets.get(ws) !== state
      || !(await auth.isSessionActive(context.sessionId, userId))
    ) {
      terminal.close();
      closeTerminalSocket(ws, 4401, "Authentication session ended");
      return;
    }
    state.terminal = terminal;
    state.outputListener = (data: Buffer) => {
      sendTerminalData(ws, Buffer.from(data));
    };
    state.errorOutputListener = (data: Buffer) => {
      sendTerminalData(ws, Buffer.from(data));
    };
    terminal.output.on("data", state.outputListener);
    terminal.errorOutput.on("data", state.errorOutputListener);
    terminal.input.on("drain", () => {
      state.inputBlocked = false;
      flushTerminalInput(ws, state);
    });
    terminal.input.on("error", () => {
      closeTerminalSocket(ws, 1011, "Terminal input failed");
    });
    flushTerminalInput(ws, state);
    void terminal.exited.then(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "Terminal exited");
    });
  } catch (error) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n환경 연결 실패: ${(error as Error).message}\r\n`);
      ws.close(1011, "Terminal unavailable");
    }
  }
});

let heartbeatRunning = false;
const heartbeat = setInterval(() => {
  if (heartbeatRunning) return;
  heartbeatRunning = true;
  void (async () => {
    const clients = [...wss.clients];
    const activeSessionIds = await auth.activeSessionIds(
      clients.flatMap((ws) => {
        const state = terminalSockets.get(ws);
        return state
          ? [{ sessionId: state.authSessionId, userId: state.userId }]
          : [];
      })
    );
    for (const ws of clients) {
      const state = terminalSockets.get(ws);
      if (!state || !activeSessionIds.has(state.authSessionId)) {
        closeTerminalSocket(ws, 4401, "Authentication session ended");
        continue;
      }
      if (aliveSockets.get(ws) === false) {
        ws.terminate();
        continue;
      }
      aliveSockets.set(ws, false);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  })()
    .catch((error) => {
      console.error("Terminal session recheck failed:", (error as Error).message);
    })
    .finally(() => {
      heartbeatRunning = false;
    });
}, 30_000);
heartbeat.unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down ${course.copy.serviceName}.`);
  clearInterval(heartbeat);
  apiLimiter.stop();
  validationLimiter.stop();
  resetLimiter.stop();
  adminSessionLimiter.stop();
  unsubscribeSessionRevocations();
  authRouter.stop();
  for (const client of wss.clients) client.close(1001, "Server shutting down");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
}

async function start() {
  const bootstrapEnvironment: NodeJS.ProcessEnv = MOCK_LAB ? {
    ...process.env,
    LAB_ADMIN_EMAIL: process.env.LAB_ADMIN_EMAIL || course.copy.mockAdminEmail,
    LAB_ADMIN_PASSWORD: process.env.LAB_ADMIN_PASSWORD || "LocalAdminPassword!2026",
    LAB_ADMIN_NAME: process.env.LAB_ADMIN_NAME || "로컬 관리자"
  } : process.env;
  await auth.bootstrapAdminFromEnv(bootstrapEnvironment);
  await auth.pruneExpiredSessions();
  const snapshot = await store.snapshot();
  if (snapshot.users.length === 0) {
    throw new Error("사용자가 없습니다. LAB_ADMIN_EMAIL과 LAB_ADMIN_PASSWORD로 최초 관리자를 설정하세요.");
  }
  await runtime.initialize();
  runtime.startJanitor();
  server.listen(PORT, HOST, () => {
    console.log(
      `${course.copy.serviceName} (${MOCK_LAB ? "mock" : course.runtimeKind}) listening on ${HOST}:${PORT}`
    );
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

void start().catch((error) => {
  console.error(`${course.copy.serviceName} failed to start:`, (error as Error).message);
  process.exitCode = 1;
});
