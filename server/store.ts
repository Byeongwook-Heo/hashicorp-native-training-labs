import crypto from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export const STORE_SCHEMA_VERSION = 1;

export type UserRole = "admin" | "instructor" | "learner";
export type UserStatus = "active" | "disabled";
export type ProgressStatus = "passed" | "skipped";

export type StoredUser = {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  cohortIds: string[];
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
};

export type StoredInvite = {
  id: string;
  codeHash: string;
  role: UserRole;
  email?: string;
  cohortId?: string;
  maxUses: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
  createdBy: string;
  revokedAt?: string;
};

export type StoredAuthSession = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ipHash?: string;
  userAgent?: string;
  revokedAt?: string;
};

export type StoredProgress = {
  id: string;
  userId: string;
  courseId: string;
  stepId: string;
  status: ProgressStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  passedAt?: string;
  skippedAt?: string;
};

export type StoredCohort = {
  id: string;
  name: string;
  courseId?: string;
  instructorIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type StoredAuditEvent = {
  id: string;
  action: string;
  createdAt: string;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  ipHash?: string;
  metadata?: Record<string, unknown>;
};

export type StoreData = {
  schemaVersion: number;
  users: StoredUser[];
  invites: StoredInvite[];
  sessions: StoredAuthSession[];
  progress: StoredProgress[];
  cohorts: StoredCohort[];
  auditEvents: StoredAuditEvent[];
};

export type PublicUser = Omit<StoredUser, "passwordHash">;

export type CreateUserInput = {
  email: string;
  displayName: string;
  passwordHash: string;
  role?: UserRole;
  status?: UserStatus;
  cohortIds?: string[];
};

export type CreateInviteInput = Omit<
  StoredInvite,
  "id" | "createdAt" | "uses" | "revokedAt"
> & {
  id?: string;
};

export type CreateSessionInput = Omit<
  StoredAuthSession,
  "id" | "createdAt" | "lastSeenAt" | "revokedAt"
> & {
  id?: string;
};

export type RecordProgressInput = {
  userId: string;
  courseId: string;
  stepId: string;
  status: ProgressStatus;
  attemptsDelta?: number;
};

export type CohortLearnerStatus = {
  user: PublicUser;
  courseId?: string;
  passed: number;
  skipped: number;
  attemptedSteps: number;
  lastActivityAt?: string;
};

export type StoreOptions = {
  filePath?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  maxAuditEvents?: number;
};

const isoNow = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function toPublicUser(user: StoredUser): PublicUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return structuredClone(publicUser);
}

function emptyStore(): StoreData {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    users: [],
    invites: [],
    sessions: [],
    progress: [],
    cohorts: [],
    auditEvents: [],
  };
}

function validateStore(value: unknown): asserts value is StoreData {
  if (!value || typeof value !== "object") {
    throw new Error("저장 파일 형식이 올바르지 않습니다.");
  }
  const candidate = value as Partial<StoreData>;
  if (candidate.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new Error(
      `지원하지 않는 저장소 스키마입니다: ${String(candidate.schemaVersion)}`,
    );
  }
  for (const key of [
    "users",
    "invites",
    "sessions",
    "progress",
    "cohorts",
    "auditEvents",
  ] as const) {
    if (!Array.isArray(candidate[key])) {
      throw new Error(`저장 파일의 ${key} 필드가 올바르지 않습니다.`);
    }
  }
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class JsonStore {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly maxAuditEvents: number;
  private readonly ready: Promise<void>;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: StoreOptions = {}) {
    this.filePath = path.resolve(
      options.filePath ??
        process.env.LAB_STORE_PATH ??
        path.join(process.cwd(), "data", "vault-lab.json"),
    );
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.maxAuditEvents = options.maxAuditEvents ?? 50_000;
    this.ready = this.initialize();
  }

  private async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await this.withProcessLock(async () => {
      try {
        const data = await this.readDisk();
        validateStore(data);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.atomicWrite(emptyStore());
      }
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readDisk(): Promise<StoreData> {
    const raw = await readFile(this.filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    validateStore(parsed);
    return parsed;
  }

  private async withProcessLock<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    let lockHandle;
    while (!lockHandle) {
      try {
        lockHandle = await open(this.lockPath, "wx", 0o600);
        await lockHandle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: isoNow() }),
          "utf8",
        );
        await lockHandle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > this.staleLockMs) {
            await unlink(this.lockPath);
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error("저장소 잠금 시간이 초과되었습니다.");
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 20 + Math.floor(Math.random() * 30)),
        );
      }
    }

    try {
      return await operation();
    } finally {
      await lockHandle.close().catch(() => undefined);
      await unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  private async atomicWrite(data: StoreData) {
    const tempPath = `${this.filePath}.${process.pid}.${crypto
      .randomBytes(8)
      .toString("hex")}.tmp`;
    let tempHandle;
    try {
      tempHandle = await open(tempPath, "wx", 0o600);
      await tempHandle.writeFile(`${JSON.stringify(data)}\n`, "utf8");
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = undefined;
      await rename(tempPath, this.filePath);
      const directoryHandle = await open(path.dirname(this.filePath), "r");
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close();
    } finally {
      await tempHandle?.close().catch(() => undefined);
      await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async snapshot(): Promise<StoreData> {
    await this.ready;
    return this.enqueue(async () => clone(await this.readDisk()));
  }

  async transaction<T>(
    operation: (draft: StoreData) => T | Promise<T>,
  ): Promise<T> {
    await this.ready;
    return this.enqueue(() =>
      this.withProcessLock(async () => {
        const draft = await this.readDisk();
        const result = await operation(draft);
        validateStore(draft);
        await this.atomicWrite(draft);
        return clone(result);
      }),
    );
  }

  async getUserById(id: string) {
    const data = await this.snapshot();
    return clone(data.users.find((user) => user.id === id));
  }

  async getUserByEmail(email: string) {
    const normalized = normalizeEmail(email);
    const data = await this.snapshot();
    return clone(data.users.find((user) => user.email === normalized));
  }

  async listUsers(filters: { role?: UserRole; cohortId?: string } = {}) {
    const data = await this.snapshot();
    return data.users
      .filter((user) => !filters.role || user.role === filters.role)
      .filter(
        (user) =>
          !filters.cohortId || user.cohortIds.includes(filters.cohortId),
      )
      .map(toPublicUser);
  }

  async createUser(input: CreateUserInput) {
    return this.transaction((data) => {
      const email = normalizeEmail(input.email);
      if (data.users.some((user) => user.email === email)) {
        throw new Error("이미 등록된 이메일입니다.");
      }
      const now = isoNow();
      const user: StoredUser = {
        id: makeId(),
        email,
        displayName: input.displayName.trim(),
        passwordHash: input.passwordHash,
        role: input.role ?? "learner",
        status: input.status ?? "active",
        cohortIds: unique(input.cohortIds ?? []),
        createdAt: now,
        updatedAt: now,
      };
      data.users.push(user);
      return user;
    });
  }

  async updateUser(
    id: string,
    patch: Partial<
      Pick<
        StoredUser,
        | "displayName"
        | "passwordHash"
        | "role"
        | "status"
        | "cohortIds"
        | "lastLoginAt"
      >
    >,
  ) {
    return this.transaction((data) => {
      const user = data.users.find((candidate) => candidate.id === id);
      if (!user) throw new Error("사용자를 찾을 수 없습니다.");
      if (patch.displayName !== undefined) {
        user.displayName = patch.displayName.trim();
      }
      if (patch.passwordHash !== undefined) user.passwordHash = patch.passwordHash;
      if (patch.role !== undefined) user.role = patch.role;
      if (patch.status !== undefined) user.status = patch.status;
      if (patch.cohortIds !== undefined) user.cohortIds = unique(patch.cohortIds);
      if (patch.lastLoginAt !== undefined) user.lastLoginAt = patch.lastLoginAt;
      user.updatedAt = isoNow();
      return user;
    });
  }

  async createInvite(input: CreateInviteInput) {
    return this.transaction((data) => {
      const invite: StoredInvite = {
        ...input,
        id: input.id ?? makeId(),
        email: input.email ? normalizeEmail(input.email) : undefined,
        maxUses: Math.max(1, Math.floor(input.maxUses)),
        uses: 0,
        createdAt: isoNow(),
      };
      data.invites.push(invite);
      return invite;
    });
  }

  async getInviteByCodeHash(codeHash: string) {
    const data = await this.snapshot();
    return clone(data.invites.find((invite) => invite.codeHash === codeHash));
  }

  async revokeInvite(id: string) {
    return this.transaction((data) => {
      const invite = data.invites.find((candidate) => candidate.id === id);
      if (!invite) throw new Error("초대 코드를 찾을 수 없습니다.");
      invite.revokedAt ??= isoNow();
      return invite;
    });
  }

  async createSession(input: CreateSessionInput) {
    return this.transaction((data) => {
      const now = isoNow();
      const session: StoredAuthSession = {
        ...input,
        id: input.id ?? makeId(),
        createdAt: now,
        lastSeenAt: now,
      };
      data.sessions.push(session);
      return session;
    });
  }

  async getSession(id: string) {
    const data = await this.snapshot();
    return clone(data.sessions.find((session) => session.id === id));
  }

  async touchSession(id: string, at = isoNow()) {
    return this.transaction((data) => {
      const session = data.sessions.find((candidate) => candidate.id === id);
      if (!session || session.revokedAt) return undefined;
      session.lastSeenAt = at;
      return session;
    });
  }

  async revokeSession(id: string) {
    return this.transaction((data) => {
      const session = data.sessions.find((candidate) => candidate.id === id);
      if (!session) return false;
      session.revokedAt ??= isoNow();
      return true;
    });
  }

  async revokeUserSessions(userId: string) {
    return this.transaction((data) => {
      const now = isoNow();
      const revokedIds: string[] = [];
      for (const session of data.sessions) {
        if (session.userId === userId && !session.revokedAt) {
          session.revokedAt = now;
          revokedIds.push(session.id);
        }
      }
      return revokedIds;
    });
  }

  async pruneExpiredSessions(now = new Date()) {
    return this.transaction((data) => {
      const removed = data.sessions.filter(
        (session) =>
          Boolean(session.revokedAt) ||
          new Date(session.expiresAt).getTime() <= now.getTime(),
      );
      const removedIds = new Set(removed.map((session) => session.id));
      data.sessions = data.sessions.filter(
        (session) => !removedIds.has(session.id),
      );
      return removed.map((session) => ({
        id: session.id,
        userId: session.userId,
        revoked: Boolean(session.revokedAt),
        expired: new Date(session.expiresAt).getTime() <= now.getTime(),
      }));
    });
  }

  async recordProgress(input: RecordProgressInput) {
    return this.transaction((data) => {
      const user = data.users.find((candidate) => candidate.id === input.userId);
      if (!user) throw new Error("사용자를 찾을 수 없습니다.");
      const now = isoNow();
      let progress = data.progress.find(
        (candidate) =>
          candidate.userId === input.userId &&
          candidate.courseId === input.courseId &&
          candidate.stepId === input.stepId,
      );
      if (!progress) {
        progress = {
          id: makeId(),
          userId: input.userId,
          courseId: input.courseId,
          stepId: input.stepId,
          status: input.status,
          attempts: Math.max(0, input.attemptsDelta ?? 0),
          createdAt: now,
          updatedAt: now,
        };
        data.progress.push(progress);
      } else {
        // A verified pass is never downgraded by a later skip.
        if (progress.status !== "passed") progress.status = input.status;
        progress.attempts += Math.max(0, input.attemptsDelta ?? 0);
        progress.updatedAt = now;
      }
      if (input.status === "passed") {
        progress.status = "passed";
        progress.passedAt ??= now;
      } else if (progress.status === "skipped") {
        progress.skippedAt ??= now;
      }
      return progress;
    });
  }

  async getProgress(userId: string, courseId?: string) {
    const data = await this.snapshot();
    return clone(
      data.progress.filter(
        (progress) =>
          progress.userId === userId &&
          (!courseId || progress.courseId === courseId),
      ),
    );
  }

  async createCohort(input: {
    name: string;
    courseId?: string;
    instructorIds?: string[];
  }) {
    return this.transaction((data) => {
      const now = isoNow();
      const cohort: StoredCohort = {
        id: makeId(),
        name: input.name.trim(),
        courseId: input.courseId?.trim() || undefined,
        instructorIds: unique(input.instructorIds ?? []),
        createdAt: now,
        updatedAt: now,
      };
      data.cohorts.push(cohort);
      return cohort;
    });
  }

  async getCohort(id: string) {
    const data = await this.snapshot();
    return clone(data.cohorts.find((cohort) => cohort.id === id));
  }

  async listCohortsForUser(user: StoredUser | PublicUser) {
    const data = await this.snapshot();
    if (user.role === "admin") return clone(data.cohorts);
    if (user.role === "instructor") {
      return clone(
        data.cohorts.filter((cohort) => cohort.instructorIds.includes(user.id)),
      );
    }
    return clone(
      data.cohorts.filter((cohort) => user.cohortIds.includes(cohort.id)),
    );
  }

  async getCohortStatus(
    cohortId: string,
    courseId?: string,
  ): Promise<CohortLearnerStatus[]> {
    const data = await this.snapshot();
    const cohort = data.cohorts.find((candidate) => candidate.id === cohortId);
    if (!cohort) throw new Error("교육 그룹을 찾을 수 없습니다.");
    const selectedCourseId = courseId ?? cohort.courseId;
    return data.users
      .filter(
        (user) => user.role === "learner" && user.cohortIds.includes(cohortId),
      )
      .map((user) => {
        const rows = data.progress.filter(
          (row) =>
            row.userId === user.id &&
            (!selectedCourseId || row.courseId === selectedCourseId),
        );
        const lastActivityAt = rows
          .map((row) => row.updatedAt)
          .sort()
          .at(-1);
        return {
          user: toPublicUser(user),
          courseId: selectedCourseId,
          passed: rows.filter((row) => row.status === "passed").length,
          skipped: rows.filter((row) => row.status === "skipped").length,
          attemptedSteps: rows.length,
          lastActivityAt,
        };
      });
  }

  async appendAudit(
    input: Omit<StoredAuditEvent, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    },
  ) {
    return this.transaction((data) => {
      const event: StoredAuditEvent = {
        ...input,
        id: input.id ?? makeId(),
        createdAt: input.createdAt ?? isoNow(),
      };
      data.auditEvents.push(event);
      if (data.auditEvents.length > this.maxAuditEvents) {
        data.auditEvents.splice(
          0,
          data.auditEvents.length - this.maxAuditEvents,
        );
      }
      return event;
    });
  }

  async listAudit(options: {
    actorUserId?: string;
    action?: string;
    limit?: number;
    before?: string;
  } = {}) {
    const data = await this.snapshot();
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    return clone(
      data.auditEvents
        .filter(
          (event) =>
            !options.actorUserId || event.actorUserId === options.actorUserId,
        )
        .filter((event) => !options.action || event.action === options.action)
        .filter(
          (event) => !options.before || event.createdAt < options.before,
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit),
    );
  }
}

export function createStore(options: StoreOptions = {}) {
  return new JsonStore(options);
}
