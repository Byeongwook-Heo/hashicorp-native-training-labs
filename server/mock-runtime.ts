import type {
  NativeCommandOptions,
  NativeCommandResult,
  NativeVaultSessionInfo
} from "./native-runtime.js";

const DEFAULT_TTL_MS = 4 * 60 * 60_000;

export class MockVaultRuntime {
  private readonly sessions = new Map<string, NativeVaultSessionInfo>();
  private readonly ttlMs = Number(process.env.SESSION_TTL_HOURS || 4) * 60 * 60_000 || DEFAULT_TTL_MS;
  private janitor: NodeJS.Timeout | null = null;

  async initialize() {}

  async getOrCreate(id: string) {
    const existing = await this.get(id);
    if (existing) return existing;
    const createdAt = Date.now();
    const session: NativeVaultSessionInfo = {
      id,
      slot: `mock-${this.sessions.size + 1}`,
      address: "mock://vault",
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      remainingMs: this.ttlMs
    };
    this.sessions.set(id, session);
    return structuredClone(session);
  }

  async get(id: string) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return {
      ...structuredClone(session),
      remainingMs: session.expiresAt - Date.now()
    };
  }

  async reset(id: string) {
    this.sessions.delete(id);
    return this.getOrCreate(id);
  }

  async destroy(id: string) {
    return this.sessions.delete(id);
  }

  async extend(id: string, additionalMs: number) {
    const session = await this.getOrCreate(id);
    const expiresAt = Math.min(Date.now() + 24 * 60 * 60_000, session.expiresAt + additionalMs);
    const updated = { ...session, expiresAt, remainingMs: expiresAt - Date.now() };
    this.sessions.set(id, updated);
    return structuredClone(updated);
  }

  async execute(
    _id: string,
    argv: readonly string[],
    _options: NativeCommandOptions
  ): Promise<NativeCommandResult> {
    const forcedFailure = process.env.MOCK_FAIL_STEP;
    const serialized = argv.join(" ");
    const ok = !forcedFailure || !serialized.includes(forcedFailure);
    const output = ok
      ? `${serialized}\nmock-validation-ok\n`
      : "mock validation was configured to fail\n";
    return {
      code: ok ? 0 : 1,
      output,
      stdout: ok ? output : "",
      stderr: ok ? "" : output,
      truncated: false
    };
  }

  async cleanupExpired() {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= Date.now()) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  startJanitor(intervalMs = 5 * 60_000) {
    if (!this.janitor) {
      this.janitor = setInterval(() => void this.cleanupExpired(), intervalMs);
      this.janitor.unref();
    }
    return () => {
      if (this.janitor) clearInterval(this.janitor);
      this.janitor = null;
    };
  }

  async close() {
    if (this.janitor) clearInterval(this.janitor);
    this.janitor = null;
  }
}
