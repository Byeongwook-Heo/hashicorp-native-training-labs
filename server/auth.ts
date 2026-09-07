import crypto from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import {
  type JsonStore,
  type ProgressStatus,
  type PublicUser,
  type StoreData,
  type StoredAuditEvent,
  type StoredAuthSession,
  type StoredInvite,
  type StoredUser,
  type UserRole,
  normalizeEmail,
  toPublicUser,
} from "./store.js";

const PASSWORD_KEY_BYTES = 32;
const PASSWORD_SCRYPT_N = 16_384;
const PASSWORD_SCRYPT_R = 8;
const PASSWORD_SCRYPT_P = 1;
const PASSWORD_MAX_LENGTH = 256;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60_000;
const AUTH_CONTEXT_KEY = "vaultLabAuth";
const REDACTED = "[REDACTED]";

export type AuthContext = {
  user: PublicUser;
  sessionId: string;
};

export type RequestIdentity = {
  ip?: string;
  userAgent?: string;
};

export type AuthServiceOptions = {
  cookieSecret?: string;
  cookieName?: string;
  cookieSecure?: boolean;
  sessionTtlMs?: number;
  courseId?: string;
  touchIntervalMs?: number;
  maxActiveSessionsPerUser?: number;
  sessionPruneIntervalMs?: number;
};

export type SessionRevocationReason =
  | "logout"
  | "disabled"
  | "expired"
  | "session-limit";

export type SessionRevocationEvent = {
  sessionId: string;
  userId: string;
  reason: SessionRevocationReason;
};

export type InvitationInput = {
  role?: UserRole;
  email?: string;
  cohortId?: string;
  expiresInHours?: number;
  maxUses?: number;
};

export type EnrollmentInput = {
  inviteCode: string;
  email: string;
  displayName: string;
  password: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

export type AuthResult = {
  user: PublicUser;
  sessionId: string;
  setCookie: string;
};

export type AuthRouterOptions = {
  loginLimit?: { windowMs: number; max: number };
  enrollmentLimit?: { windowMs: number; max: number };
  generalMutationLimit?: { windowMs: number; max: number };
};

export type AuthRouter = {
  router: express.Router;
  rateLimiters: RateLimiter[];
  stop: () => void;
};

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "AUTH_ERROR",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomUUID();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hmac(secret: string, value: string) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function constantEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parseCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizeInviteCode(code: string) {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function formatInviteCode(raw: string) {
  return raw.match(/.{1,4}/g)?.join("-") ?? raw;
}

function validateEmail(email: string) {
  const normalized = normalizeEmail(email);
  if (
    normalized.length < 3 ||
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new AuthError("올바른 이메일 주소를 입력해 주세요.");
  }
  return normalized;
}

function validatePassword(password: string) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new AuthError("비밀번호는 12자 이상 256자 이하로 입력해 주세요.");
  }
  if (
    !/[a-zA-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^a-zA-Z0-9]/.test(password)
  ) {
    throw new AuthError("비밀번호에 영문, 숫자, 특수문자를 포함해 주세요.");
  }
}

function validateDisplayName(displayName: string) {
  const normalized = displayName?.trim();
  if (!normalized || normalized.length > 80) {
    throw new AuthError("이름은 1자 이상 80자 이하로 입력해 주세요.");
  }
  return normalized;
}

function validateRole(value: unknown): UserRole {
  if (value === "admin" || value === "instructor" || value === "learner") {
    return value;
  }
  throw new AuthError("role은 admin, instructor, learner 중 하나여야 합니다.");
}

function scrypt(
  password: string,
  salt: Buffer,
  options: { N: number; r: number; p: number },
) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      PASSWORD_KEY_BYTES,
      {
        ...options,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(password: string) {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, {
    N: PASSWORD_SCRYPT_N,
    r: PASSWORD_SCRYPT_R,
    p: PASSWORD_SCRYPT_P,
  });
  return [
    "scrypt",
    PASSWORD_SCRYPT_N,
    PASSWORD_SCRYPT_R,
    PASSWORD_SCRYPT_P,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, nValue, rValue, pValue, saltValue, hashValue, extra] =
    encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    extra !== undefined ||
    !nValue ||
    !rValue ||
    !pValue ||
    !saltValue ||
    !hashValue
  ) {
    return false;
  }
  const N = Number(nValue);
  const r = Number(rValue);
  const p = Number(pValue);
  // Refuse attacker-controlled work factors from a damaged store.
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 4_096 ||
    N > 65_536 ||
    r < 1 ||
    r > 16 ||
    p < 1 ||
    p > 4
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(hashValue, "base64url");
    if (salt.length < 16 || expected.length !== PASSWORD_KEY_BYTES) return false;
    const actual = await scrypt(password.slice(0, PASSWORD_MAX_LENGTH), salt, {
      N,
      r,
      p,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function isSensitiveKey(key: string) {
  return /(password|token|secret|cookie|authorization|invite.?code)/i.test(key);
}

export function sanitizeAuditMetadata(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeAuditMetadata(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [
          key,
          isSensitiveKey(key)
            ? REDACTED
            : sanitizeAuditMetadata(item, depth + 1),
        ]),
    );
  }
  return String(value).slice(0, 500);
}

function addAudit(
  data: StoreData,
  input: Omit<StoredAuditEvent, "id" | "createdAt">,
) {
  data.auditEvents.push({
    ...input,
    id: randomId(),
    createdAt: nowIso(),
    metadata: input.metadata
      ? (sanitizeAuditMetadata(input.metadata) as Record<string, unknown>)
      : undefined,
  });
  if (data.auditEvents.length > 50_000) {
    data.auditEvents.splice(0, data.auditEvents.length - 50_000);
  }
}

function identityFromRequest(request: Request): RequestIdentity {
  return {
    ip: request.ip || request.socket.remoteAddress,
    userAgent: request.get("user-agent")?.slice(0, 300),
  };
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parsePositiveNumber(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AuthError("양수 값을 입력해 주세요.");
  }
  return Math.min(maximum, Math.floor(parsed));
}

function handleError(
  error: unknown,
  response: Response,
  next: NextFunction,
) {
  if (error instanceof AuthError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  next(error);
}

function asyncHandler(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch((error) =>
      handleError(error, response, next),
    );
  };
}

export class AuthService {
  readonly cookieName: string;
  readonly sessionTtlMs: number;
  readonly courseId: string;
  private readonly cookieSecret: string;
  private readonly cookieSecure: boolean;
  private readonly touchIntervalMs: number;
  private readonly maxActiveSessionsPerUser: number;
  private readonly tokenSecret: string;
  private readonly inviteSecret: string;
  private readonly identitySecret: string;
  private readonly revocationListeners = new Set<
    (event: SessionRevocationEvent) => void
  >();
  private sessionPruneTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly store: JsonStore,
    options: AuthServiceOptions = {},
  ) {
    const secret = options.cookieSecret ?? process.env.AUTH_COOKIE_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
      throw new Error("AUTH_COOKIE_SECRET은 32바이트 이상의 값이어야 합니다.");
    }
    this.cookieSecret = secret;
    this.cookieName =
      options.cookieName ?? process.env.AUTH_COOKIE_NAME ?? "vaultLabAuth";
    this.cookieSecure =
      options.cookieSecure ??
      (process.env.AUTH_COOKIE_SECURE
        ? process.env.AUTH_COOKIE_SECURE !== "false"
        : process.env.NODE_ENV === "production");
    this.sessionTtlMs =
      options.sessionTtlMs ??
      Number(process.env.AUTH_SESSION_TTL_MS || DEFAULT_SESSION_TTL_MS);
    if (
      !Number.isFinite(this.sessionTtlMs) ||
      this.sessionTtlMs < 5 * 60_000 ||
      this.sessionTtlMs > 30 * 24 * 60 * 60_000
    ) {
      throw new Error(
        "AUTH_SESSION_TTL_MS는 5분 이상 30일 이하로 설정해야 합니다.",
      );
    }
    this.courseId = options.courseId ?? "vault-foundations";
    this.touchIntervalMs = options.touchIntervalMs ?? 5 * 60_000;
    this.maxActiveSessionsPerUser =
      options.maxActiveSessionsPerUser ??
      Number(process.env.AUTH_MAX_SESSIONS_PER_USER || 5);
    if (
      !Number.isInteger(this.maxActiveSessionsPerUser) ||
      this.maxActiveSessionsPerUser < 1 ||
      this.maxActiveSessionsPerUser > 20
    ) {
      throw new Error(
        "AUTH_MAX_SESSIONS_PER_USER는 1 이상 20 이하의 정수여야 합니다.",
      );
    }
    this.tokenSecret = hmac(secret, "session-token-pepper");
    this.inviteSecret = hmac(secret, "invite-code-pepper");
    this.identitySecret = hmac(secret, "request-identity-pepper");
    const pruneIntervalMs =
      options.sessionPruneIntervalMs ??
      Number(process.env.AUTH_SESSION_PRUNE_INTERVAL_MS || 15 * 60_000);
    if (
      !Number.isFinite(pruneIntervalMs) ||
      pruneIntervalMs < 10_000 ||
      pruneIntervalMs > 24 * 60 * 60_000
    ) {
      throw new Error(
        "AUTH_SESSION_PRUNE_INTERVAL_MS는 10초 이상 24시간 이하여야 합니다.",
      );
    }
    this.startSessionJanitor(pruneIntervalMs);
  }

  private hashSessionToken(token: string) {
    return hmac(this.tokenSecret, token);
  }

  onSessionRevoked(
    listener: (event: SessionRevocationEvent) => void,
  ): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  private emitSessionRevoked(event: SessionRevocationEvent) {
    for (const listener of this.revocationListeners) {
      try {
        listener(event);
      } catch {
        // Revocation must not fail because an in-process observer failed.
      }
    }
  }

  async isSessionActive(sessionId: string, expectedUserId?: string) {
    const session = await this.store.getSession(sessionId);
    if (
      !session ||
      session.revokedAt ||
      new Date(session.expiresAt).getTime() <= Date.now() ||
      (expectedUserId !== undefined && session.userId !== expectedUserId)
    ) {
      return false;
    }
    const user = await this.store.getUserById(session.userId);
    return user?.status === "active";
  }

  async activeSessionIds(
    expected: readonly { sessionId: string; userId: string }[],
  ): Promise<Set<string>> {
    if (expected.length === 0) return new Set();
    const expectedUsers = new Map(
      expected.map((item) => [item.sessionId, item.userId]),
    );
    const data = await this.store.snapshot();
    const now = Date.now();
    const activeUsers = new Set(
      data.users
        .filter((user) => user.status === "active")
        .map((user) => user.id),
    );
    return new Set(
      data.sessions
        .filter(
          (session) =>
            expectedUsers.get(session.id) === session.userId &&
            !session.revokedAt &&
            new Date(session.expiresAt).getTime() > now &&
            activeUsers.has(session.userId),
        )
        .map((session) => session.id),
    );
  }

  private startSessionJanitor(intervalMs: number) {
    if (this.sessionPruneTimer) return;
    this.sessionPruneTimer = setInterval(() => {
      void this.pruneExpiredSessions().catch((error) => {
        console.error("Auth session cleanup failed:", (error as Error).message);
      });
    }, intervalMs);
    this.sessionPruneTimer.unref();
  }

  async pruneExpiredSessions() {
    const removed = await this.store.pruneExpiredSessions();
    for (const session of removed) {
      // A previously revoked session has already notified in-process consumers.
      if (session.revoked || !session.expired) continue;
      this.emitSessionRevoked({
        sessionId: session.id,
        userId: session.userId,
        reason: "expired",
      });
    }
    return removed.length;
  }

  stop() {
    if (this.sessionPruneTimer) clearInterval(this.sessionPruneTimer);
    this.sessionPruneTimer = undefined;
    this.revocationListeners.clear();
  }

  private hashInviteCode(code: string) {
    return hmac(this.inviteSecret, normalizeInviteCode(code));
  }

  private hashIp(ip?: string) {
    return ip ? hmac(this.identitySecret, ip) : undefined;
  }

  private signedCookieValue(sessionId: string, token: string) {
    const body = Buffer.from(`${sessionId}.${token}`).toString("base64url");
    return `v1.${body}.${hmac(this.cookieSecret, `v1.${body}`)}`;
  }

  private decodeSignedCookie(value: string | undefined) {
    if (!value) return undefined;
    const [version, body, signature, extra] = value.split(".");
    if (
      version !== "v1" ||
      !body ||
      !signature ||
      extra !== undefined ||
      !constantEqual(signature, hmac(this.cookieSecret, `${version}.${body}`))
    ) {
      return undefined;
    }
    try {
      const decoded = Buffer.from(body, "base64url").toString("utf8");
      const separator = decoded.indexOf(".");
      if (separator < 1) return undefined;
      return {
        sessionId: decoded.slice(0, separator),
        token: decoded.slice(separator + 1),
      };
    } catch {
      return undefined;
    }
  }

  private cookieHeader(value: string, maxAgeSeconds: number) {
    const attributes = [
      `${this.cookieName}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ];
    if (this.cookieSecure) attributes.push("Secure");
    return attributes.join("; ");
  }

  clearCookieHeader() {
    return this.cookieHeader("", 0);
  }

  private async issueSession(
    userId: string,
    identity: RequestIdentity,
  ): Promise<AuthResult> {
    const token = randomToken();
    const sessionId = randomId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs).toISOString();
    const result = await this.store.transaction((data) => {
      const user = data.users.find((candidate) => candidate.id === userId);
      if (!user || user.status !== "active") {
        throw new AuthError("활성 사용자를 찾을 수 없습니다.", 403, "USER_DISABLED");
      }
      const removedExpired = data.sessions.filter(
        (candidate) =>
          Boolean(candidate.revokedAt) ||
          new Date(candidate.expiresAt).getTime() <= now.getTime(),
      );
      if (removedExpired.length > 0) {
        const removedIds = new Set(removedExpired.map((candidate) => candidate.id));
        data.sessions = data.sessions.filter(
          (candidate) => !removedIds.has(candidate.id),
        );
      }
      const activeForUser = data.sessions
        .filter((candidate) => candidate.userId === userId && !candidate.revokedAt)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const evicted = activeForUser.slice(
        0,
        Math.max(
          0,
          activeForUser.length - this.maxActiveSessionsPerUser + 1,
        ),
      );
      for (const candidate of evicted) {
        candidate.revokedAt = now.toISOString();
        addAudit(data, {
          action: "auth.session_evicted",
          actorUserId: user.id,
          targetType: "session",
          targetId: candidate.id,
          metadata: { reason: "active-session-limit" },
        });
      }
      const session: StoredAuthSession = {
        id: sessionId,
        userId,
        tokenHash: this.hashSessionToken(token),
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt,
        ipHash: this.hashIp(identity.ip),
        userAgent: identity.userAgent?.slice(0, 300),
      };
      data.sessions.push(session);
      user.lastLoginAt = now.toISOString();
      user.updatedAt = now.toISOString();
      addAudit(data, {
        action: "auth.login",
        actorUserId: user.id,
        targetType: "session",
        targetId: session.id,
        ipHash: this.hashIp(identity.ip),
      });
      return {
        user: toPublicUser(user),
        evicted: evicted.map((candidate) => ({
          id: candidate.id,
          userId: candidate.userId,
        })),
        expired: removedExpired
          .filter(
            (candidate) =>
              !candidate.revokedAt &&
              new Date(candidate.expiresAt).getTime() <= now.getTime(),
          )
          .map((candidate) => ({
            id: candidate.id,
            userId: candidate.userId,
          })),
      };
    });
    for (const candidate of result.expired) {
      this.emitSessionRevoked({
        sessionId: candidate.id,
        userId: candidate.userId,
        reason: "expired",
      });
    }
    for (const candidate of result.evicted) {
      this.emitSessionRevoked({
        sessionId: candidate.id,
        userId: candidate.userId,
        reason: "session-limit",
      });
    }
    return {
      user: result.user,
      sessionId,
      setCookie: this.cookieHeader(
        this.signedCookieValue(sessionId, token),
        this.sessionTtlMs / 1_000,
      ),
    };
  }

  async authenticateCookieHeader(
    cookieHeader: string | undefined,
  ): Promise<AuthContext | undefined> {
    const rawCookie = parseCookie(cookieHeader, this.cookieName);
    const decoded = this.decodeSignedCookie(rawCookie);
    if (!decoded) return undefined;
    const session = await this.store.getSession(decoded.sessionId);
    if (
      !session ||
      session.revokedAt ||
      new Date(session.expiresAt).getTime() <= Date.now() ||
      !constantEqual(session.tokenHash, this.hashSessionToken(decoded.token))
    ) {
      return undefined;
    }
    const user = await this.store.getUserById(session.userId);
    if (!user || user.status !== "active") return undefined;
    if (
      Date.now() - new Date(session.lastSeenAt).getTime() >=
      this.touchIntervalMs
    ) {
      await this.store.touchSession(session.id);
    }
    return { user: toPublicUser(user), sessionId: session.id };
  }

  async authenticateRequest(request: Request): Promise<AuthContext | undefined> {
    return this.authenticateCookieHeader(request.headers.cookie);
  }

  authenticate: RequestHandler = (request, response, next) => {
    void this.authenticateRequest(request)
      .then((context) => {
        if (context) response.locals[AUTH_CONTEXT_KEY] = context;
        next();
      })
      .catch(next);
  };

  requireAuth: RequestHandler = (_request, response, next) => {
    if (!getAuthContext(response)) {
      response.status(401).json({
        error: "로그인이 필요합니다.",
        code: "AUTH_REQUIRED",
      });
      return;
    }
    next();
  };

  requireRole(...roles: UserRole[]): RequestHandler {
    return (_request, response, next) => {
      const context = getAuthContext(response);
      if (!context) {
        response
          .status(401)
          .json({ error: "로그인이 필요합니다.", code: "AUTH_REQUIRED" });
        return;
      }
      if (!roles.includes(context.user.role)) {
        response
          .status(403)
          .json({ error: "권한이 없습니다.", code: "ROLE_REQUIRED" });
        return;
      }
      next();
    };
  }

  async bootstrapAdminFromEnv(
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<PublicUser | undefined> {
    const email = environment.LAB_ADMIN_EMAIL ?? environment.ADMIN_EMAIL;
    const password =
      environment.LAB_ADMIN_PASSWORD ?? environment.ADMIN_PASSWORD;
    const displayName =
      environment.LAB_ADMIN_NAME ?? environment.ADMIN_NAME ?? "Lab Admin";
    if (!email && !password) return undefined;
    if (!email || !password) {
      throw new Error(
        "관리자 부트스트랩에는 LAB_ADMIN_EMAIL과 LAB_ADMIN_PASSWORD가 모두 필요합니다.",
      );
    }
    const normalizedEmail = validateEmail(email);
    const existing = await this.store.getUserByEmail(normalizedEmail);
    if (existing) {
      if (existing.role !== "admin") {
        throw new Error("부트스트랩 관리자 이메일이 일반 계정에 사용 중입니다.");
      }
      return toPublicUser(existing);
    }
    const passwordHash = await hashPassword(password);
    const user = await this.store.transaction((data) => {
      const raced = data.users.find(
        (candidate) => candidate.email === normalizedEmail,
      );
      if (raced) {
        if (raced.role !== "admin") {
          throw new Error("부트스트랩 관리자 이메일이 일반 계정에 사용 중입니다.");
        }
        return raced;
      }
      const timestamp = nowIso();
      const created: StoredUser = {
        id: randomId(),
        email: normalizedEmail,
        displayName: validateDisplayName(displayName),
        passwordHash,
        role: "admin",
        status: "active",
        cohortIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.users.push(created);
      addAudit(data, {
        action: "admin.bootstrap",
        actorUserId: created.id,
        targetType: "user",
        targetId: created.id,
      });
      return created;
    });
    return toPublicUser(user);
  }

  async login(input: LoginInput, identity: RequestIdentity = {}) {
    const email = validateEmail(input.email);
    const user = await this.store.getUserByEmail(email);
    // Keep the expensive operation even when the account does not exist.
    const dummyHash =
      "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$8D9LDDWa1HJtmOdmR4j6DeL2Zyd8T3Qx7ngUFZfokhE";
    const valid = await verifyPassword(
      asString(input.password),
      user?.passwordHash ?? dummyHash,
    );
    if (!user || !valid) {
      await this.store.appendAudit({
        action: "auth.login_failed",
        ipHash: this.hashIp(identity.ip),
        metadata: { email },
      });
      throw new AuthError(
        "이메일 또는 비밀번호가 올바르지 않습니다.",
        401,
        "INVALID_CREDENTIALS",
      );
    }
    if (user.status !== "active") {
      await this.store.appendAudit({
        action: "auth.login_blocked",
        actorUserId: user.id,
        targetType: "user",
        targetId: user.id,
        ipHash: this.hashIp(identity.ip),
      });
      throw new AuthError(
        "비활성화된 계정입니다.",
        403,
        "USER_DISABLED",
      );
    }
    return this.issueSession(user.id, identity);
  }

  async logout(
    context: AuthContext | undefined,
    identity: RequestIdentity = {},
  ) {
    if (!context) return;
    const revoked = await this.store.transaction((data) => {
      const session = data.sessions.find(
        (candidate) => candidate.id === context.sessionId,
      );
      const newlyRevoked = Boolean(session && !session.revokedAt);
      if (session) session.revokedAt ??= nowIso();
      addAudit(data, {
        action: "auth.logout",
        actorUserId: context.user.id,
        targetType: "session",
        targetId: context.sessionId,
        ipHash: this.hashIp(identity.ip),
      });
      return newlyRevoked && session
        ? { id: session.id, userId: session.userId }
        : undefined;
    });
    if (revoked) {
      this.emitSessionRevoked({
        sessionId: revoked.id,
        userId: revoked.userId,
        reason: "logout",
      });
    }
  }

  async createInvitation(
    actor: PublicUser,
    input: InvitationInput,
    identity: RequestIdentity = {},
  ) {
    const role = validateRole(input.role ?? "learner");
    if (actor.role === "learner") {
      throw new AuthError("초대를 만들 권한이 없습니다.", 403);
    }
    if (actor.role === "instructor" && role !== "learner") {
      throw new AuthError("강사는 교육생만 초대할 수 있습니다.", 403);
    }
    const expiresInHours = parsePositiveNumber(
      input.expiresInHours,
      72,
      24 * 30,
    );
    const maxUses = parsePositiveNumber(input.maxUses, 1, 1_000);
    const email = input.email ? validateEmail(input.email) : undefined;
    const rawCode = crypto.randomBytes(12).toString("hex").toUpperCase();
    const inviteCode = formatInviteCode(rawCode);
    const invite = await this.store.transaction((data) => {
      if (input.cohortId) {
        const cohort = data.cohorts.find(
          (candidate) => candidate.id === input.cohortId && !candidate.archivedAt,
        );
        if (!cohort) throw new AuthError("교육 그룹을 찾을 수 없습니다.", 404);
        if (
          actor.role === "instructor" &&
          !cohort.instructorIds.includes(actor.id)
        ) {
          throw new AuthError("이 교육 그룹을 관리할 권한이 없습니다.", 403);
        }
      } else if (actor.role === "instructor") {
        throw new AuthError("강사 초대에는 교육 그룹이 필요합니다.");
      }
      const created: StoredInvite = {
        id: randomId(),
        codeHash: this.hashInviteCode(inviteCode),
        role,
        email,
        cohortId: input.cohortId,
        maxUses,
        uses: 0,
        expiresAt: new Date(
          Date.now() + expiresInHours * 60 * 60_000,
        ).toISOString(),
        createdAt: nowIso(),
        createdBy: actor.id,
      };
      data.invites.push(created);
      addAudit(data, {
        action: "invite.created",
        actorUserId: actor.id,
        targetType: "invite",
        targetId: created.id,
        ipHash: this.hashIp(identity.ip),
        metadata: {
          role,
          email,
          cohortId: input.cohortId,
          maxUses,
          expiresAt: created.expiresAt,
        },
      });
      return created;
    });
    const { codeHash: _codeHash, ...publicInvite } = invite;
    return { invite: publicInvite, inviteCode };
  }

  async listInvitations(actor: PublicUser) {
    if (actor.role === "learner") {
      throw new AuthError("초대를 조회할 권한이 없습니다.", 403);
    }
    const data = await this.store.snapshot();
    const allowedCohortIds =
      actor.role === "admin"
        ? undefined
        : new Set(
            data.cohorts
              .filter((cohort) => cohort.instructorIds.includes(actor.id))
              .map((cohort) => cohort.id),
          );
    return data.invites
      .filter(
        (invite) =>
          actor.role === "admin" ||
          (invite.cohortId && allowedCohortIds?.has(invite.cohortId)),
      )
      .map(({ codeHash: _codeHash, ...invite }) => invite)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async revokeInvitation(
    actor: PublicUser,
    inviteId: string,
    identity: RequestIdentity = {},
  ) {
    return this.store.transaction((data) => {
      const invite = data.invites.find((candidate) => candidate.id === inviteId);
      if (!invite) throw new AuthError("초대를 찾을 수 없습니다.", 404);
      if (actor.role === "learner") {
        throw new AuthError("초대를 취소할 권한이 없습니다.", 403);
      }
      if (actor.role === "instructor") {
        const cohort = invite.cohortId
          ? data.cohorts.find((candidate) => candidate.id === invite.cohortId)
          : undefined;
        if (!cohort?.instructorIds.includes(actor.id)) {
          throw new AuthError("이 초대를 취소할 권한이 없습니다.", 403);
        }
      }
      invite.revokedAt ??= nowIso();
      addAudit(data, {
        action: "invite.revoked",
        actorUserId: actor.id,
        targetType: "invite",
        targetId: invite.id,
        ipHash: this.hashIp(identity.ip),
      });
      return true;
    });
  }

  async enroll(
    input: EnrollmentInput,
    identity: RequestIdentity = {},
  ): Promise<AuthResult> {
    const email = validateEmail(input.email);
    const displayName = validateDisplayName(input.displayName);
    const passwordHash = await hashPassword(input.password);
    const codeHash = this.hashInviteCode(input.inviteCode);
    const user = await this.store.transaction((data) => {
      const invite = data.invites.find(
        (candidate) => candidate.codeHash === codeHash,
      );
      const invalidInvite =
        !invite ||
        Boolean(invite.revokedAt) ||
        new Date(invite.expiresAt).getTime() <= Date.now() ||
        invite.uses >= invite.maxUses;
      if (invalidInvite) {
        throw new AuthError(
          "초대 코드가 유효하지 않거나 만료되었습니다.",
          400,
          "INVALID_INVITE",
        );
      }
      if (invite.email && invite.email !== email) {
        throw new AuthError(
          "이 초대 코드에 지정된 이메일과 일치하지 않습니다.",
          400,
          "INVITE_EMAIL_MISMATCH",
        );
      }
      if (data.users.some((candidate) => candidate.email === email)) {
        throw new AuthError("이미 등록된 이메일입니다.", 409, "EMAIL_EXISTS");
      }
      if (
        invite.cohortId &&
        !data.cohorts.some(
          (cohort) => cohort.id === invite.cohortId && !cohort.archivedAt,
        )
      ) {
        throw new AuthError("초대의 교육 그룹을 사용할 수 없습니다.", 400);
      }
      const timestamp = nowIso();
      const created: StoredUser = {
        id: randomId(),
        email,
        displayName,
        passwordHash,
        role: invite.role,
        status: "active",
        cohortIds: invite.cohortId ? [invite.cohortId] : [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.users.push(created);
      if (invite.cohortId && invite.role === "instructor") {
        const cohort = data.cohorts.find(
          (candidate) => candidate.id === invite.cohortId,
        );
        if (cohort && !cohort.instructorIds.includes(created.id)) {
          cohort.instructorIds.push(created.id);
          cohort.updatedAt = timestamp;
        }
      }
      invite.uses += 1;
      addAudit(data, {
        action: "invite.redeemed",
        actorUserId: created.id,
        targetType: "invite",
        targetId: invite.id,
        ipHash: this.hashIp(identity.ip),
        metadata: { cohortId: invite.cohortId, role: invite.role },
      });
      addAudit(data, {
        action: "user.enrolled",
        actorUserId: created.id,
        targetType: "user",
        targetId: created.id,
        ipHash: this.hashIp(identity.ip),
        metadata: { cohortId: invite.cohortId, role: invite.role },
      });
      return created;
    });
    return this.issueSession(user.id, identity);
  }

  async recordVerifiedPass(
    actor: PublicUser,
    stepId: string,
    courseId = this.courseId,
    attemptsDelta = 1,
    identity: RequestIdentity = {},
  ) {
    return this.recordProgress(
      actor,
      stepId,
      "passed",
      courseId,
      attemptsDelta,
      identity,
    );
  }

  async recordSkip(
    actor: PublicUser,
    stepId: string,
    courseId = this.courseId,
    identity: RequestIdentity = {},
  ) {
    return this.recordProgress(actor, stepId, "skipped", courseId, 0, identity);
  }

  private async recordProgress(
    actor: PublicUser,
    stepId: string,
    status: ProgressStatus,
    courseId: string,
    attemptsDelta: number,
    identity: RequestIdentity,
  ) {
    if (!stepId.trim() || stepId.length > 160 || !courseId.trim()) {
      throw new AuthError("과정 또는 단계 ID가 올바르지 않습니다.");
    }
    const progress = await this.store.recordProgress({
      userId: actor.id,
      courseId,
      stepId,
      status,
      attemptsDelta,
    });
    await this.store.appendAudit({
      action: status === "passed" ? "progress.passed" : "progress.skipped",
      actorUserId: actor.id,
      targetType: "step",
      targetId: stepId,
      ipHash: this.hashIp(identity.ip),
      metadata: { courseId, attempts: progress.attempts },
    });
    return progress;
  }

  async createCohort(
    actor: PublicUser,
    input: { name: string; courseId?: string; instructorIds?: string[] },
    identity: RequestIdentity = {},
  ) {
    if (actor.role === "learner") {
      throw new AuthError("교육 그룹을 만들 권한이 없습니다.", 403);
    }
    const name = input.name?.trim();
    if (!name || name.length > 120) {
      throw new AuthError("교육 그룹 이름은 1자 이상 120자 이하로 입력해 주세요.");
    }
    const cohort = await this.store.createCohort({
      name,
      courseId: input.courseId?.trim() || this.courseId,
      instructorIds:
        actor.role === "instructor"
          ? [actor.id]
          : input.instructorIds ?? [actor.id],
    });
    await this.store.appendAudit({
      action: "cohort.created",
      actorUserId: actor.id,
      targetType: "cohort",
      targetId: cohort.id,
      ipHash: this.hashIp(identity.ip),
      metadata: { name: cohort.name, courseId: cohort.courseId },
    });
    return cohort;
  }

  async listCohorts(actor: PublicUser) {
    return this.store.listCohortsForUser(actor);
  }

  async getCohortStatus(
    actor: PublicUser,
    cohortId: string,
    courseId?: string,
  ) {
    const cohort = await this.store.getCohort(cohortId);
    if (!cohort) throw new AuthError("교육 그룹을 찾을 수 없습니다.", 404);
    if (
      actor.role !== "admin" &&
      !(
        actor.role === "instructor" &&
        cohort.instructorIds.includes(actor.id)
      )
    ) {
      throw new AuthError("이 교육 그룹을 조회할 권한이 없습니다.", 403);
    }
    return this.store.getCohortStatus(cohortId, courseId);
  }

  async setUserStatus(
    actor: PublicUser,
    userId: string,
    status: "active" | "disabled",
    identity: RequestIdentity = {},
  ) {
    if (actor.role !== "admin") {
      throw new AuthError("관리자 권한이 필요합니다.", 403);
    }
    if (actor.id === userId && status === "disabled") {
      throw new AuthError("현재 관리자 계정은 비활성화할 수 없습니다.");
    }
    const user = await this.store.updateUser(userId, { status });
    if (status === "disabled") {
      const revokedSessionIds = await this.store.revokeUserSessions(userId);
      for (const sessionId of revokedSessionIds) {
        this.emitSessionRevoked({
          sessionId,
          userId,
          reason: "disabled",
        });
      }
    }
    await this.store.appendAudit({
      action: `user.${status}`,
      actorUserId: actor.id,
      targetType: "user",
      targetId: userId,
      ipHash: this.hashIp(identity.ip),
    });
    return toPublicUser(user);
  }

  async listAudit(
    actor: PublicUser,
    options: { action?: string; limit?: number; before?: string } = {},
  ) {
    if (actor.role === "learner") {
      throw new AuthError("감사 로그를 조회할 권한이 없습니다.", 403);
    }
    const normalizedLimit = Number.isFinite(options.limit)
      ? Math.min(500, Math.max(1, Math.floor(options.limit!)))
      : undefined;
    const events = await this.store.listAudit({
      ...options,
      limit: normalizedLimit,
    });
    if (actor.role === "admin") return events;
    const cohorts = await this.store.listCohortsForUser(actor);
    const cohortIds = new Set(cohorts.map((cohort) => cohort.id));
    const learnerIds = new Set(
      (
        await Promise.all(
          [...cohortIds].map((cohortId) =>
            this.store.listUsers({ cohortId }),
          ),
        )
      )
        .flat()
        .map((user) => user.id),
    );
    return events.filter(
      (event) =>
        event.actorUserId === actor.id ||
        (event.actorUserId && learnerIds.has(event.actorUserId)) ||
        (typeof event.metadata?.cohortId === "string" &&
          cohortIds.has(event.metadata.cohortId)),
    );
  }
}

export function getAuthContext(response: Response): AuthContext | undefined {
  return response.locals[AUTH_CONTEXT_KEY] as AuthContext | undefined;
}

export function createAuthService(
  store: JsonStore,
  options: AuthServiceOptions = {},
) {
  return new AuthService(store, options);
}

export function createAuthRouter(
  auth: AuthService,
  options: AuthRouterOptions = {},
): AuthRouter {
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));

  const loginLimiter = createRateLimiter({
    windowMs: options.loginLimit?.windowMs ?? 15 * 60_000,
    max: options.loginLimit?.max ?? 10,
    key: (request) =>
      `${request.ip}:${normalizeEmail(asString(request.body?.email))}`,
    message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  });
  const enrollmentLimiter = createRateLimiter({
    windowMs: options.enrollmentLimit?.windowMs ?? 60 * 60_000,
    max: options.enrollmentLimit?.max ?? 10,
    message: "가입 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  });
  const mutationLimiter = createRateLimiter({
    windowMs: options.generalMutationLimit?.windowMs ?? 60_000,
    max: options.generalMutationLimit?.max ?? 120,
  });
  const rateLimiters = [loginLimiter, enrollmentLimiter, mutationLimiter];

  router.post(
    "/login",
    loginLimiter.middleware,
    asyncHandler(async (request, response) => {
      const result = await auth.login(
        {
          email: asString(request.body?.email),
          password: asString(request.body?.password),
        },
        identityFromRequest(request),
      );
      response.setHeader("Set-Cookie", result.setCookie);
      response.json({ user: result.user });
    }),
  );

  router.post(
    "/enroll",
    enrollmentLimiter.middleware,
    asyncHandler(async (request, response) => {
      const result = await auth.enroll(
        {
          inviteCode: asString(request.body?.inviteCode),
          email: asString(request.body?.email),
          displayName: asString(request.body?.displayName),
          password: asString(request.body?.password),
        },
        identityFromRequest(request),
      );
      response.setHeader("Set-Cookie", result.setCookie);
      response.status(201).json({ user: result.user });
    }),
  );

  router.use(auth.authenticate);

  router.get("/me", (request, response) => {
    const context = getAuthContext(response);
    response.json({ user: context?.user ?? null });
  });

  router.post(
    "/logout",
    mutationLimiter.middleware,
    asyncHandler(async (request, response) => {
      await auth.logout(getAuthContext(response), identityFromRequest(request));
      response.setHeader("Set-Cookie", auth.clearCookieHeader());
      response.status(204).end();
    }),
  );

  router.get(
    "/progress",
    auth.requireAuth,
    asyncHandler(async (request, response) => {
      const context = getAuthContext(response)!;
      const courseId =
        typeof request.query.courseId === "string"
          ? request.query.courseId
          : auth.courseId;
      const progress = await auth.store.getProgress(context.user.id, courseId);
      response.json({ courseId, progress });
    }),
  );

  router.get(
    "/invites",
    auth.requireRole("admin", "instructor"),
    asyncHandler(async (_request, response) => {
      const invites = await auth.listInvitations(getAuthContext(response)!.user);
      response.json({ invites });
    }),
  );

  router.post(
    "/invites",
    mutationLimiter.middleware,
    auth.requireRole("admin", "instructor"),
    asyncHandler(async (request, response) => {
      const result = await auth.createInvitation(
        getAuthContext(response)!.user,
        {
          role: request.body?.role,
          email: asString(request.body?.email) || undefined,
          cohortId: asString(request.body?.cohortId) || undefined,
          expiresInHours: request.body?.expiresInHours,
          maxUses: request.body?.maxUses,
        },
        identityFromRequest(request),
      );
      response.status(201).json(result);
    }),
  );

  router.post(
    "/invites/:inviteId/revoke",
    mutationLimiter.middleware,
    auth.requireRole("admin", "instructor"),
    asyncHandler(async (request, response) => {
      await auth.revokeInvitation(
        getAuthContext(response)!.user,
        asString(request.params.inviteId),
        identityFromRequest(request),
      );
      response.json({ ok: true });
    }),
  );

  router.get(
    "/cohorts",
    auth.requireAuth,
    asyncHandler(async (_request, response) => {
      const cohorts = await auth.listCohorts(getAuthContext(response)!.user);
      response.json({ cohorts });
    }),
  );

  router.post(
    "/cohorts",
    mutationLimiter.middleware,
    auth.requireRole("admin", "instructor"),
    asyncHandler(async (request, response) => {
      const cohort = await auth.createCohort(
        getAuthContext(response)!.user,
        {
          name: asString(request.body?.name),
          courseId: asString(request.body?.courseId) || undefined,
          instructorIds: Array.isArray(request.body?.instructorIds)
            ? request.body.instructorIds.filter(
                (value: unknown): value is string => typeof value === "string",
              )
            : undefined,
        },
        identityFromRequest(request),
      );
      response.status(201).json({ cohort });
    }),
  );

  router.get(
    "/cohorts/:cohortId/status",
    auth.requireRole("admin", "instructor"),
    asyncHandler(async (request, response) => {
      const courseId =
        typeof request.query.courseId === "string"
          ? request.query.courseId
          : undefined;
      const learners = await auth.getCohortStatus(
        getAuthContext(response)!.user,
        asString(request.params.cohortId),
        courseId,
      );
      response.json({ learners });
    }),
  );

  router.get(
    "/audit",
    auth.requireRole("admin", "instructor"),
    asyncHandler(async (request, response) => {
      const events = await auth.listAudit(getAuthContext(response)!.user, {
        action:
          typeof request.query.action === "string"
            ? request.query.action
            : undefined,
        before:
          typeof request.query.before === "string"
            ? request.query.before
            : undefined,
        limit:
          typeof request.query.limit === "string"
            ? Number(request.query.limit)
            : undefined,
      });
      response.json({ events });
    }),
  );

  router.post(
    "/users/:userId/status",
    mutationLimiter.middleware,
    auth.requireRole("admin"),
    asyncHandler(async (request, response) => {
      const status = request.body?.status;
      if (status !== "active" && status !== "disabled") {
        throw new AuthError("status는 active 또는 disabled여야 합니다.");
      }
      const user = await auth.setUserStatus(
        getAuthContext(response)!.user,
        asString(request.params.userId),
        status,
        identityFromRequest(request),
      );
      response.json({ user });
    }),
  );

  return {
    router,
    rateLimiters,
    stop() {
      for (const limiter of rateLimiters) limiter.stop();
      auth.stop();
    },
  };
}
