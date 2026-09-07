import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;
const SLOT_PATTERN = /^s[0-9]{2}$/;
const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1_000;
const METADATA_VERSION = 2;
const VAULT_API_PORT = 820;
const NATIVE_CONTROL_ABI = "4";
const STUDENT_POLICY = `
path "sys/health" {
  capabilities = ["read"]
}
path "sys/mounts" {
  capabilities = ["read"]
}
path "sys/mounts/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}
path "sys/auth" {
  capabilities = ["read"]
}
path "sys/auth/approle" {
  capabilities = ["create", "read", "update", "sudo"]
  allowed_parameters = {
    "type" = ["approle"]
  }
}
path "sys/audit" {
  capabilities = ["read", "list", "sudo"]
}
path "sys/policies/acl" {
  capabilities = ["list"]
}
path "sys/capabilities" {
  capabilities = ["update"]
}
path "sys/capabilities-self" {
  capabilities = ["update"]
}
path "auth/token/create/app-read-role" {
  capabilities = ["create", "update"]
}
path "auth/token/lookup" {
  capabilities = ["create", "update"]
}
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/revoke-accessor" {
  capabilities = ["update"]
}
path "training/*" {
  capabilities = ["create", "read", "update", "delete", "list", "patch", "sudo"]
}
path "transit/*" {
  capabilities = ["create", "read", "update", "delete", "list", "patch", "sudo"]
}
path "pki/*" {
  capabilities = ["create", "read", "update", "delete", "list", "patch", "sudo"]
}
path "auth/approle/role/demo-app" {
  capabilities = ["create", "read", "update"]
  allowed_parameters = {
    "token_policies" = ["app-read"]
    "token_ttl" = ["1h"]
    "token_max_ttl" = ["4h"]
    "secret_id_num_uses" = ["10"]
    "token_type" = ["service"]
    "bind_secret_id" = ["true"]
    "secret_id_ttl" = ["10m"]
  }
}
path "auth/approle/role/demo-app/role-id" {
  capabilities = ["read"]
}
path "auth/approle/role/demo-app/secret-id" {
  capabilities = ["create", "update"]
}
path "auth/approle/login" {
  capabilities = ["create", "update"]
}
`.trim();

export type NativeRuntimeErrorCode =
  | "CAPACITY"
  | "INVALID_SESSION"
  | "NOT_INITIALIZED"
  | "SESSION_UNAVAILABLE"
  | "RUNTIME_MISCONFIGURED"
  | "COMMAND_FAILED";

export class NativeRuntimeError extends Error {
  readonly code: NativeRuntimeErrorCode;

  constructor(code: NativeRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeRuntimeError";
    this.code = code;
  }
}

export interface NativeVaultRuntimeOptions {
  /**
   * Number of pre-provisioned Linux-user slots that may be active at once.
   * infra/native-install.sh must provision at least this many slots.
   */
  maxSessions?: number;
  sessionTtlMs?: number;
  stateRoot?: string;
  runtimeRoot?: string;
  controlBinary?: string;
  controlAbiFile?: string;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  commandMaxOutputBytes?: number;
  /** Maximum number of active plus waiting serialized runtime operations. */
  maxQueuedOperations?: number;
}

export interface NativeVaultSessionInfo {
  id: string;
  slot: string;
  address: string;
  createdAt: number;
  expiresAt: number;
  remainingMs: number;
}

export interface NativeCommandOptions {
  operation: "verify" | "skip";
  stepId: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface NativeCommandResult {
  code: number;
  output: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function isExactVerifierResult(
  stepId: string,
  result: Pick<NativeCommandResult, "code" | "stdout" | "truncated">
): boolean {
  return (
    result.code === 0
    && !result.truncated
    && result.stdout.trim() === `verified:${stepId}`
  );
}

/**
 * A byte-stream terminal channel designed to be bridged directly to ws:
 *
 *   terminal.output.on("data", data => ws.send(data));
 *   terminal.errorOutput.on("data", data => ws.send(data));
 *   ws.on("message", data => terminal.write(data));
 *   ws.on("close", () => terminal.close());
 */
export interface NativeTerminalChannel {
  readonly output: Readable;
  readonly errorOutput: Readable;
  readonly input: Writable;
  readonly pid?: number;
  write(data: Buffer | Uint8Array | string): boolean;
  close(): void;
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface SessionMetadata {
  version: typeof METADATA_VERSION;
  id: string;
  generation: string;
  slot: string;
  port: number;
  createdAt: number;
  expiresAt: number;
}

interface SessionRecord extends SessionMetadata {
  rootToken: string;
}

interface ProcessResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
}

export function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function createSessionId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function slotLoopbackAddress(slot: string): string {
  if (!SLOT_PATTERN.test(slot)) {
    throw new NativeRuntimeError(
      "RUNTIME_MISCONFIGURED",
      "내부 슬롯 ID가 안전하지 않습니다."
    );
  }
  const number = Number(slot.slice(1));
  if (!Number.isInteger(number) || number < 1 || number > 99) {
    throw new NativeRuntimeError(
      "RUNTIME_MISCONFIGURED",
      "내부 슬롯 번호가 안전하지 않습니다."
    );
  }
  return `127.77.0.${number}`;
}

/** Preserve a valid browser session ID, or issue a fresh cryptographically random one. */
export function resolveSessionId(value: unknown): string {
  return isSafeSessionId(value) ? value : createSessionId();
}

function requireSafeSessionId(value: string): void {
  if (!isSafeSessionId(value)) {
    throw new NativeRuntimeError(
      "INVALID_SESSION",
      "실습 세션 ID 형식이 올바르지 않습니다."
    );
  }
}

function readPositiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new NativeRuntimeError(
      "RUNTIME_MISCONFIGURED",
      `${name} 값은 1부터 ${maximum} 사이의 정수여야 합니다.`
    );
  }
  return value;
}

function sanitizeOutput(value: Buffer): string {
  return value
    .toString("utf8")
    .replace(/\u0000/g, "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\ud7ff\ue000-\ufffd]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Manages native Vault server processes backed by a fixed pool of hardened Linux
 * users and systemd services. This class is intentionally single-owner: initialize()
 * acquires a process lock so two Node processes cannot allocate the same slot.
 */
export class NativeVaultRuntime {
  private readonly options: Required<NativeVaultRuntimeOptions>;
  private readonly sessions = new Map<string, SessionRecord>();
  private initializePromise: Promise<void> | null = null;
  private initialized = false;
  private closed = false;
  private lockQueue: Promise<void> = Promise.resolve();
  private queuedOperations = 0;
  private processLockNonce: string | null = null;
  private janitor: NodeJS.Timeout | null = null;

  constructor(options: NativeVaultRuntimeOptions = {}) {
    const maxSessions = readPositiveInteger(
      "maxSessions",
      options.maxSessions ?? Number(process.env.MAX_SESSIONS || DEFAULT_MAX_SESSIONS),
      99
    );
    const ttl = options.sessionTtlMs
      ?? (process.env.SESSION_TTL_HOURS
        ? Number(process.env.SESSION_TTL_HOURS) * 60 * 60 * 1_000
        : DEFAULT_SESSION_TTL_MS);

    this.options = {
      maxSessions,
      sessionTtlMs: readPositiveInteger("sessionTtlMs", ttl, 24 * 60 * 60 * 1_000),
      stateRoot: options.stateRoot ?? "/var/lib/vault-lab/sessions",
      runtimeRoot: options.runtimeRoot ?? "/run/vault-lab/slots",
      controlBinary: options.controlBinary ?? "/usr/local/sbin/vault-lab-control",
      controlAbiFile:
        options.controlAbiFile ?? "/etc/vault-lab/native-control-abi",
      startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 20_000,
      commandMaxOutputBytes: options.commandMaxOutputBytes ?? 1_048_576,
      maxQueuedOperations: readPositiveInteger(
        "maxQueuedOperations",
        options.maxQueuedOperations
          ?? Number(process.env.MAX_RUNTIME_QUEUE || Math.max(16, maxSessions * 4)),
        512
      )
    };

  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.closed) {
      throw new NativeRuntimeError("NOT_INITIALIZED", "종료된 런타임은 다시 사용할 수 없습니다.");
    }
    this.initializePromise ??= this.initializeInternal().catch((error) => {
      this.initializePromise = null;
      throw error;
    });
    await this.initializePromise;
  }

  async getOrCreate(id: string): Promise<NativeVaultSessionInfo> {
    requireSafeSessionId(id);
    return this.toInfo(await this.getOrCreateRecord(id));
  }

  async get(id: string): Promise<NativeVaultSessionInfo | null> {
    requireSafeSessionId(id);
    await this.initialize();
    return this.withLock(async () => {
      const record = this.sessions.get(id);
      if (!record) return null;
      if (record.expiresAt <= Date.now() || !(await this.isReady(record))) {
        await this.destroyRecord(record);
        return null;
      }
      return this.toInfo(record);
    });
  }

  async reset(id: string): Promise<NativeVaultSessionInfo> {
    requireSafeSessionId(id);
    await this.initialize();
    return this.withLock(async () => {
      const existing = this.sessions.get(id);
      const preferredSlot = existing?.slot;
      if (existing) await this.destroyRecord(existing);
      await this.cleanupExpiredLocked();
      return this.toInfo(await this.createRecord(id, preferredSlot));
    });
  }

  /**
   * Extend an existing session without allowing an administrator to push its
   * expiry beyond 24 hours from the time of this request. A fresh student token
   * is issued with the new TTL; connected terminals retain their previous token
   * until they reconnect.
   */
  async extend(id: string, additionalMs: number): Promise<NativeVaultSessionInfo> {
    requireSafeSessionId(id);
    readPositiveInteger("additionalMs", additionalMs, 24 * 60 * 60 * 1_000);
    await this.initialize();
    return this.withLock(async () => {
      const record = this.sessions.get(id);
      if (!record || record.expiresAt <= Date.now() || !(await this.isReady(record))) {
        if (record) await this.destroyRecord(record);
        throw new NativeRuntimeError(
          "SESSION_UNAVAILABLE",
          "연장할 활성 실습 세션을 찾을 수 없습니다."
        );
      }

      const maximumExpiry = Date.now() + 24 * 60 * 60 * 1_000;
      const expiresAt = Math.min(record.expiresAt + additionalMs, maximumExpiry);
      if (expiresAt <= record.expiresAt) return this.toInfo(record);

      const extended: SessionRecord = { ...record, expiresAt };
      await this.control([
        "extend-guard",
        record.slot,
        record.generation,
        String(expiresAt)
      ]);
      try {
        const studentToken = await this.createStudentToken(extended);
        await this.writeExpiryFiles(extended, studentToken);
      } catch (error) {
        await this.control([
          "extend-guard",
          record.slot,
          record.generation,
          String(record.expiresAt)
        ]).catch(() => undefined);
        throw error;
      }
      this.sessions.set(id, extended);
      return this.toInfo(extended);
    });
  }

  async destroy(id: string): Promise<boolean> {
    requireSafeSessionId(id);
    await this.initialize();
    return this.withLock(async () => {
      const record = this.sessions.get(id);
      if (!record) return false;
      await this.destroyRecord(record);
      return true;
    });
  }

  /**
   * Execute an argv array inside the session's hardened command scope. No shell is
   * introduced by the runtime; pass ["/bin/sh", "-c", "..."] explicitly only for
   * trusted curriculum commands that require shell syntax.
   */
  async execute(
    id: string,
    argv: readonly string[],
    options: NativeCommandOptions
  ): Promise<NativeCommandResult> {
    requireSafeSessionId(id);
    if (argv.length === 0 || argv.some((item) => typeof item !== "string" || item.includes("\u0000"))) {
      throw new NativeRuntimeError("COMMAND_FAILED", "실행할 명령 인자가 올바르지 않습니다.");
    }
    if (
      (options.operation !== "verify" && options.operation !== "skip")
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.stepId)
    ) {
      throw new NativeRuntimeError("COMMAND_FAILED", "검증 작업 계약이 올바르지 않습니다.");
    }
    const session = await this.getOrCreateRecord(id);
    const timeoutMs = Math.min(
      Math.max(250, options.timeoutMs ?? this.options.commandTimeoutMs),
      30_000
    );
    const maxOutputBytes = Math.min(
      Math.max(4_096, options.maxOutputBytes ?? this.options.commandMaxOutputBytes),
      4 * 1_048_576
    );
    const result = await this.runControl(
      [
        "command",
        session.slot,
        session.generation,
        options.operation,
        options.stepId,
        "--",
        ...argv
      ],
      timeoutMs,
      maxOutputBytes
    );
    const stdout = sanitizeOutput(result.stdout);
    const stderr = sanitizeOutput(result.stderr);
    return {
      code: result.code,
      stdout,
      stderr,
      output: `${stdout}${stderr}`,
      truncated: result.truncated
    };
  }

  async openTerminal(id: string): Promise<NativeTerminalChannel> {
    requireSafeSessionId(id);
    const session = await this.getOrCreateRecord(id);
    const remainingSeconds = Math.max(
      1,
      Math.ceil((session.expiresAt - Date.now()) / 1_000)
    );
    const child = spawn(
      "sudo",
      [
        "-n",
        this.options.controlBinary,
        "terminal",
        session.slot,
        session.generation,
        String(remainingSeconds)
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8"
        }
      }
    );
    return this.terminalChannel(child);
  }

  async cleanupExpired(): Promise<number> {
    await this.initialize();
    return this.withLock(() => this.cleanupExpiredLocked());
  }

  startJanitor(intervalMs = 5 * 60_000): () => void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000) {
      throw new NativeRuntimeError(
        "RUNTIME_MISCONFIGURED",
        "정리 주기는 10초 이상의 정수여야 합니다."
      );
    }
    if (!this.janitor) {
      this.janitor = setInterval(() => {
        void this.cleanupExpired().catch((error) => {
          // Never serialize session credentials in janitor logs.
          console.error("Native Vault session cleanup failed:", (error as Error).message);
        });
      }, intervalMs);
      this.janitor.unref();
    }
    return () => this.stopJanitor();
  }

  stopJanitor(): void {
    if (this.janitor) clearInterval(this.janitor);
    this.janitor = null;
  }

  /**
   * Releases this runtime's allocation lock. Existing Vault sessions remain alive
   * and can be adopted by the next app process from their /run metadata.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.stopJanitor();
    this.closed = true;
    this.initialized = false;
    this.sessions.clear();
    await this.releaseProcessLock();
  }

  private async getOrCreateRecord(id: string): Promise<SessionRecord> {
    requireSafeSessionId(id);
    await this.initialize();
    return this.withLock(async () => {
      await this.cleanupExpiredLocked();
      const existing = this.sessions.get(id);
      if (existing) {
        if (await this.isReady(existing)) return existing;
        await this.destroyRecord(existing);
      }
      return this.createRecord(id);
    });
  }

  private async initializeInternal(): Promise<void> {
    const installedAbi = await fs.readFile(
      this.options.controlAbiFile,
      "utf8"
    ).then((value) => value.trim()).catch((error) => {
      throw new NativeRuntimeError(
        "RUNTIME_MISCONFIGURED",
        "네이티브 제어 ABI 파일을 읽을 수 없습니다.",
        { cause: error }
      );
    });
    if (installedAbi !== NATIVE_CONTROL_ABI) {
      throw new NativeRuntimeError(
        "RUNTIME_MISCONFIGURED",
        "애플리케이션과 네이티브 제어 도구의 ABI가 일치하지 않습니다."
      );
    }
    await fs.access(this.options.controlBinary, fs.constants.X_OK).catch((error) => {
      throw new NativeRuntimeError(
        "RUNTIME_MISCONFIGURED",
        `네이티브 제어 도구를 실행할 수 없습니다: ${this.options.controlBinary}`,
        { cause: error }
      );
    });
    await fs.mkdir(this.options.runtimeRoot, { recursive: true, mode: 0o750 });
    await this.acquireProcessLock();

    try {
      for (const slot of this.slotNames()) {
        const hasCommitMarker = await fs.access(
          path.join(this.slotDirectory(slot), "metadata.json"),
          fs.constants.R_OK
        ).then(() => true).catch(() => false);
        const record = await this.readSlot(slot);
        if (!record) {
          if (hasCommitMarker) await this.control(["prepare", slot]);
          continue;
        }
        if (record.expiresAt <= Date.now() || !(await this.isReady(record))) {
          await this.control(["prepare", slot]);
          continue;
        }
        if (this.sessions.has(record.id)) {
          await this.control(["prepare", slot]);
          continue;
        }
        this.sessions.set(record.id, record);
      }
      this.initialized = true;
    } catch (error) {
      await this.releaseProcessLock();
      throw error;
    }
  }

  private async createRecord(id: string, preferredSlot?: string): Promise<SessionRecord> {
    if (this.sessions.size >= this.options.maxSessions) {
      throw new NativeRuntimeError("CAPACITY", "현재 실습 환경이 모두 사용 중입니다.");
    }

    const usedSlots = new Set([...this.sessions.values()].map((record) => record.slot));
    const slot = preferredSlot && SLOT_PATTERN.test(preferredSlot) && !usedSlots.has(preferredSlot)
      ? preferredSlot
      : this.slotNames().find((candidate) => !usedSlots.has(candidate));
    if (!slot) {
      throw new NativeRuntimeError("CAPACITY", "사용 가능한 네이티브 실습 슬롯이 없습니다.");
    }

      const port = VAULT_API_PORT;
    const createdAt = Date.now();
    const recordBase: SessionMetadata = {
      version: METADATA_VERSION,
      id,
      generation: createSessionId(),
      slot,
      port,
      createdAt,
      expiresAt: createdAt + this.options.sessionTtlMs
    };

    try {
      await this.control(["prepare", slot]);
      await this.writeSlotConfiguration(recordBase);
      await this.control(["start", slot]);
      await this.waitForState(recordBase, (state) => state.initialized === false);

      const initialized = await this.vaultRequest(recordBase, "/v1/sys/init", {
        method: "POST",
        body: JSON.stringify({ secret_shares: 1, secret_threshold: 1 })
      });
      if (
        !isRecord(initialized)
        || !Array.isArray(initialized.keys_base64)
        || typeof initialized.keys_base64[0] !== "string"
        || typeof initialized.root_token !== "string"
        || initialized.root_token.length < 16
      ) {
        throw new NativeRuntimeError(
          "SESSION_UNAVAILABLE",
          "Vault 초기화 응답에 필요한 자격 증명이 없습니다."
        );
      }

      const unsealKey = initialized.keys_base64[0];
      const rootToken = initialized.root_token;
      const unsealed = await this.vaultRequest(recordBase, "/v1/sys/unseal", {
        method: "POST",
        body: JSON.stringify({ key: unsealKey })
      });
      if (!isRecord(unsealed) || unsealed.sealed !== false) {
        throw new NativeRuntimeError("SESSION_UNAVAILABLE", "Vault unseal에 실패했습니다.");
      }

      const record: SessionRecord = { ...recordBase, rootToken };
      await this.configureSessionAudit(record);
      const studentToken = await this.createStudentToken(record);
      await this.writeSecretFiles(record, studentToken);
      await this.waitForState(
        record,
        (state) => state.initialized === true && state.sealed === false
      );
      this.sessions.set(id, record);
      return record;
    } catch (error) {
      await this.control(["prepare", slot]).catch(() => undefined);
      if (error instanceof NativeRuntimeError) throw error;
      throw new NativeRuntimeError(
        "SESSION_UNAVAILABLE",
        "네이티브 Vault 실습 환경을 시작하지 못했습니다.",
        { cause: error }
      );
    }
  }

  private async destroyRecord(record: SessionRecord): Promise<void> {
    this.sessions.delete(record.id);
    await this.control(["prepare", record.slot]);
  }

  private async cleanupExpiredLocked(): Promise<number> {
    const expired = [...this.sessions.values()].filter((record) => record.expiresAt <= Date.now());
    for (const record of expired) await this.destroyRecord(record);
    return expired.length;
  }

  private async readSlot(slot: string): Promise<SessionRecord | null> {
    const slotDir = this.slotDirectory(slot);
    try {
      const [metadataText, rootTokenText, sessionIdText, expiresAtText] = await Promise.all([
        fs.readFile(path.join(slotDir, "metadata.json"), "utf8"),
        fs.readFile(path.join(slotDir, "root-token"), "utf8"),
        fs.readFile(path.join(slotDir, "session-id"), "utf8"),
        fs.readFile(path.join(slotDir, "expires-at"), "utf8")
      ]);
      const value: unknown = JSON.parse(metadataText);
      const rootToken = rootTokenText.trim();
      const sessionId = sessionIdText.trim();
      const expiresAt = Number(expiresAtText.trim());
      if (
        !isRecord(value)
        || value.version !== METADATA_VERSION
        || !isSafeSessionId(value.id)
        || !isSafeSessionId(value.generation)
        || sessionId !== value.generation
        || value.slot !== slot
        || typeof value.port !== "number"
        || !Number.isSafeInteger(value.port)
        || value.port !== VAULT_API_PORT
        || typeof value.createdAt !== "number"
        || typeof value.expiresAt !== "number"
        || !Number.isSafeInteger(value.expiresAt)
        || expiresAt !== value.expiresAt
        || rootToken.length < 16
      ) {
        return null;
      }
      return {
        version: METADATA_VERSION,
        id: value.id,
        generation: value.generation,
        slot,
        port: value.port,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        rootToken
      };
    } catch {
      return null;
    }
  }

  private async writeSlotConfiguration(record: SessionMetadata): Promise<void> {
    const stateDir = path.join(this.options.stateRoot, record.slot);
    const address = slotLoopbackAddress(record.slot);
    const config = [
      "ui = false",
      "disable_mlock = true",
      'log_level = "warn"',
      'plugin_directory = "/var/empty"',
      `api_addr = "http://${address}:${record.port}"`,
      `cluster_addr = "http://${address}:${record.port + 1}"`,
      'storage "file" {',
      `  path = "${stateDir}/data"`,
      "}",
      'listener "tcp" {',
      `  address = "${address}:${record.port}"`,
      `  cluster_address = "${address}:${record.port + 1}"`,
      "  tls_disable = true",
      "}",
      ""
    ].join("\n");
    await this.atomicWrite(path.join(this.slotDirectory(record.slot), "vault.hcl"), config, 0o640);
  }

  private async createStudentToken(record: SessionRecord): Promise<string> {
    const headers = { "x-vault-token": record.rootToken };
    await this.vaultRequest(record, "/v1/sys/policies/acl/lab-student", {
      method: "PUT",
      headers,
      body: JSON.stringify({ policy: STUDENT_POLICY })
    });
    await this.vaultRequest(record, "/v1/auth/token/roles/app-read-role", {
      method: "POST",
      headers,
      body: JSON.stringify({
        allowed_policies: ["app-read"],
        disallowed_policies: ["root"],
        orphan: false,
        renewable: false,
        token_explicit_max_ttl: 1_800,
        token_type: "service",
        token_no_default_policy: false
      })
    });
    const ttlSeconds = Math.max(
      60,
      Math.ceil((record.expiresAt - Date.now()) / 1_000)
    );
    const response = await this.vaultRequest(record, "/v1/auth/token/create", {
      method: "POST",
      headers,
      body: JSON.stringify({
        policies: ["default", "lab-student"],
        ttl: `${ttlSeconds}s`,
        renewable: false,
        display_name: "vault-lab-student"
      })
    });
    if (
      !isRecord(response)
      || !isRecord(response.auth)
      || typeof response.auth.client_token !== "string"
      || response.auth.client_token.length < 16
    ) {
      throw new NativeRuntimeError(
        "SESSION_UNAVAILABLE",
        "교육생용 제한 토큰을 발급하지 못했습니다."
      );
    }
    return response.auth.client_token;
  }

  private async configureSessionAudit(record: SessionRecord): Promise<void> {
    const headers = { "x-vault-token": record.rootToken };
    await this.vaultRequest(record, "/v1/sys/audit/file", {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "file",
        options: {
          file_path: "/tmp/vault-audit.log",
          mode: "0640",
          log_raw: "false"
        }
      })
    });
    const configured = await this.vaultRequest(record, "/v1/sys/audit", {
      headers
    });
    if (
      !isRecord(configured)
      || !isRecord(configured["file/"])
      || configured["file/"].type !== "file"
      || !isRecord(configured["file/"].options)
      || configured["file/"].options.file_path !== "/tmp/vault-audit.log"
      || configured["file/"].options.mode !== "0640"
      || configured["file/"].options.log_raw !== "false"
    ) {
      throw new NativeRuntimeError(
        "SESSION_UNAVAILABLE",
        "세션 감사 장치를 안전하게 구성하지 못했습니다."
      );
    }
  }

  private async writeSecretFiles(record: SessionRecord, studentToken: string): Promise<void> {
    const slotDir = this.slotDirectory(record.slot);
    // The root token is readable by the trusted Node runtime only. Validator
    // scopes receive it through a systemd credential, never through terminal env.
    await this.atomicWrite(path.join(slotDir, "root-token"), `${record.rootToken}\n`, 0o600);
    await this.atomicWrite(path.join(slotDir, "port"), `${record.port}\n`, 0o640);
    await this.atomicWrite(
      path.join(slotDir, "address"),
      `${slotLoopbackAddress(record.slot)}\n`,
      0o640
    );
    await this.writeExpiryFiles(record, studentToken);
  }

  private async writeExpiryFiles(record: SessionRecord, studentToken: string): Promise<void> {
    const slotDir = this.slotDirectory(record.slot);
    const metadata: SessionMetadata = {
      version: METADATA_VERSION,
      id: record.id,
      generation: record.generation,
      slot: record.slot,
      port: record.port,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt
    };
    await this.atomicWrite(path.join(slotDir, "student-token"), `${studentToken}\n`, 0o640);
    await this.atomicWrite(path.join(slotDir, "expires-at"), `${record.expiresAt}\n`, 0o640);
    await this.atomicWrite(
      path.join(slotDir, "session-id"),
      `${record.generation}\n`,
      0o640
    );
    // metadata.json is the commit marker and must be written last.
    await this.atomicWrite(
      path.join(slotDir, "metadata.json"),
      `${JSON.stringify(metadata)}\n`,
      0o640
    );
  }

  private async atomicWrite(file: string, value: string, mode: number): Promise<void> {
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
    );
    await fs.writeFile(temporary, value, { encoding: "utf8", mode, flag: "wx" });
    try {
      await fs.chmod(temporary, mode);
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async isReady(record: SessionMetadata): Promise<boolean> {
    try {
      const state = await this.readHealth(record, 1_500);
      return state.initialized === true && state.sealed === false;
    } catch {
      return false;
    }
  }

  private async waitForState(
    record: SessionMetadata,
    predicate: (state: Record<string, unknown>) => boolean
  ): Promise<void> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const state = await this.readHealth(record, 1_000);
        if (predicate(state)) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new NativeRuntimeError(
      "SESSION_UNAVAILABLE",
      "Vault가 제한 시간 안에 준비되지 않았습니다.",
      lastError ? { cause: lastError } : undefined
    );
  }

  private async readHealth(
    record: SessionMetadata,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const value = await this.vaultRequest(
      record,
      "/v1/sys/health?standbyok=true&perfstandbyok=true",
      {},
      timeoutMs,
      true
    );
    if (!isRecord(value)) throw new Error("Unexpected Vault health response");
    return value;
  }

  private async vaultRequest(
    record: Pick<SessionMetadata, "slot" | "port">,
    requestPath: string,
    init: RequestInit = {},
    timeoutMs = 3_000,
    allowErrorStatus = false
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `http://${slotLoopbackAddress(record.slot)}:${record.port}${requestPath}`,
        {
        ...init,
        redirect: "error",
        headers: { "content-type": "application/json", ...init.headers },
        signal: controller.signal
        }
      );
      const text = await response.text();
      if (!response.ok && !allowErrorStatus) {
        throw new NativeRuntimeError(
          "SESSION_UNAVAILABLE",
          `Vault 내부 요청이 실패했습니다 (HTTP ${response.status}).`
        );
      }
      if (!text) return {};
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  private async control(args: readonly string[]): Promise<void> {
    const result = await this.runControl(args, 30_000, 256 * 1_024);
    if (result.code !== 0) {
      const detail = sanitizeOutput(result.stderr).trim();
      throw new NativeRuntimeError(
        "SESSION_UNAVAILABLE",
        detail ? `네이티브 런타임 제어 실패: ${detail}` : "네이티브 런타임 제어에 실패했습니다."
      );
    }
  }

  private runControl(
    args: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "sudo",
        ["-n", this.options.controlBinary, ...args],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            LANG: "C.UTF-8"
          }
        }
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let settled = false;
      const append = (target: Buffer[], chunk: Buffer) => {
        if (bytes >= maxOutputBytes) {
          truncated = true;
          return;
        }
        const remaining = maxOutputBytes - bytes;
        const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        target.push(kept);
        bytes += kept.length;
        if (kept.length !== chunk.length) truncated = true;
      };
      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new NativeRuntimeError(
          "COMMAND_FAILED",
          "네이티브 제어 프로세스를 시작하지 못했습니다.",
          { cause: error }
        ));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          signal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          truncated
        });
      });
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      }, timeoutMs);
      timer.unref();
    });
  }

  private terminalChannel(child: ChildProcessWithoutNullStreams): NativeTerminalChannel {
    let closed = false;
    // Prevent a failed sudo spawn from becoming an unhandled EventEmitter error.
    child.once("error", () => undefined);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("close", (code, signal) => resolve({ code, signal }))
    );
    const close = () => {
      if (closed) return;
      closed = true;
      child.stdin.end();
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }, 1_000);
      forceTimer.unref();
    };
    return {
      output: child.stdout,
      errorOutput: child.stderr,
      input: child.stdin,
      pid: child.pid,
      write: (data) => !closed && child.stdin.writable ? child.stdin.write(data) : false,
      close,
      kill: (signal = "SIGTERM") => {
        closed = true;
        child.kill(signal);
      },
      exited
    };
  }

  private toInfo(record: SessionMetadata): NativeVaultSessionInfo {
    return {
      id: record.id,
      slot: record.slot,
      address: `http://${slotLoopbackAddress(record.slot)}:${record.port}`,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      remainingMs: Math.max(0, record.expiresAt - Date.now())
    };
  }

  private slotNames(): string[] {
    return Array.from(
      { length: this.options.maxSessions },
      (_, index) => `s${String(index + 1).padStart(2, "0")}`
    );
  }

  private slotDirectory(slot: string): string {
    if (!SLOT_PATTERN.test(slot)) {
      throw new NativeRuntimeError("RUNTIME_MISCONFIGURED", "내부 슬롯 ID가 안전하지 않습니다.");
    }
    return path.join(this.options.runtimeRoot, slot);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queuedOperations >= this.options.maxQueuedOperations) {
      throw new NativeRuntimeError(
        "CAPACITY",
        "실습 환경 요청이 많습니다. 잠시 후 다시 시도해 주세요."
      );
    }
    this.queuedOperations += 1;
    let release!: () => void;
    const previous = this.lockQueue;
    this.lockQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await operation();
    } finally {
      this.queuedOperations -= 1;
      release();
    }
  }

  private async acquireProcessLock(): Promise<void> {
    const lockDirectory = path.join(
      path.dirname(this.options.runtimeRoot),
      "app",
      ".owner-lock"
    );
    const nonce = crypto.randomBytes(16).toString("hex");
    const create = async () => {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockDirectory, "owner.json"),
        `${JSON.stringify({ pid: process.pid, nonce })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" }
      );
    };

    try {
      await create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ownerPid = 0;
      try {
        const owner: unknown = JSON.parse(
          await fs.readFile(path.join(lockDirectory, "owner.json"), "utf8")
        );
        if (isRecord(owner) && typeof owner.pid === "number") ownerPid = owner.pid;
      } catch {
        ownerPid = 0;
      }
      let ownerAlive = false;
      if (ownerPid > 1) {
        try {
          process.kill(ownerPid, 0);
          ownerAlive = true;
        } catch (killError) {
          ownerAlive = (killError as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (ownerAlive) {
        throw new NativeRuntimeError(
          "RUNTIME_MISCONFIGURED",
          "다른 Vault Lab 런타임 프로세스가 이미 슬롯을 관리하고 있습니다."
        );
      }
      await fs.rm(lockDirectory, { recursive: true, force: true });
      await create();
    }
    this.processLockNonce = nonce;
  }

  private async releaseProcessLock(): Promise<void> {
    if (!this.processLockNonce) return;
    const lockDirectory = path.join(
      path.dirname(this.options.runtimeRoot),
      "app",
      ".owner-lock"
    );
    try {
      const owner: unknown = JSON.parse(
        await fs.readFile(path.join(lockDirectory, "owner.json"), "utf8")
      );
      if (
        isRecord(owner)
        && owner.pid === process.pid
        && owner.nonce === this.processLockNonce
      ) {
        await fs.rm(lockDirectory, { recursive: true, force: true });
      }
    } catch {
      // A missing lock during shutdown is already effectively released.
    }
    this.processLockNonce = null;
  }
}
