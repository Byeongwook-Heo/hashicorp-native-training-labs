import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LabRuntime, LabSessionInfo } from "./course-definition.js";
import {
  NativeRuntimeError,
  createSessionId,
  isSafeSessionId,
  type NativeCommandOptions,
  type NativeCommandResult,
  type NativeTerminalChannel
} from "./native-runtime.js";

const SLOT_PATTERN = /^s[0-9]{2}$/;
const GENERATION_PATTERN = /^[a-f0-9]{32}$/;
const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1_000;
const METADATA_VERSION = 1;
const NATIVE_CONTROL_ABI = "2";

export interface NativeTerraformRuntimeOptions {
  maxSessions?: number;
  sessionTtlMs?: number;
  stateRoot?: string;
  runtimeRoot?: string;
  controlBinary?: string;
  controlAbiFile?: string;
  commandTimeoutMs?: number;
  commandMaxOutputBytes?: number;
  maxQueuedOperations?: number;
}

interface TerraformSessionRecord {
  version: typeof METADATA_VERSION;
  id: string;
  generation: string;
  slot: string;
  createdAt: number;
  expiresAt: number;
}

interface ProcessResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
}

function requireSafeSessionId(value: string): void {
  if (!isSafeSessionId(value)) {
    throw new NativeRuntimeError(
      "INVALID_SESSION",
      "Terraform 실습 세션 ID 형식이 올바르지 않습니다."
    );
  }
}

function requirePositiveInteger(name: string, value: number, maximum: number): number {
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
 * Docker-free Terraform runtime backed by a fixed pool of native Linux users.
 * The root-owned control broker owns every privileged transition; this process
 * only commits bounded session metadata and passes trusted curriculum argv.
 */
export class NativeTerraformRuntime implements LabRuntime {
  private readonly options: Required<NativeTerraformRuntimeOptions>;
  private readonly sessions = new Map<string, TerraformSessionRecord>();
  private initialized = false;
  private closed = false;
  private initializePromise: Promise<void> | null = null;
  private janitor: NodeJS.Timeout | null = null;
  private lockQueue: Promise<void> = Promise.resolve();
  private queuedOperations = 0;
  private processLockNonce: string | null = null;

  constructor(options: NativeTerraformRuntimeOptions = {}) {
    const maxSessions = requirePositiveInteger(
      "maxSessions",
      options.maxSessions ?? Number(process.env.MAX_SESSIONS || DEFAULT_MAX_SESSIONS),
      99
    );
    const configuredTtl = options.sessionTtlMs
      ?? (process.env.SESSION_TTL_HOURS
        ? Number(process.env.SESSION_TTL_HOURS) * 60 * 60 * 1_000
        : DEFAULT_SESSION_TTL_MS);
    this.options = {
      maxSessions,
      sessionTtlMs: requirePositiveInteger(
        "sessionTtlMs",
        configuredTtl,
        24 * 60 * 60 * 1_000
      ),
      stateRoot: options.stateRoot ?? "/var/lib/terraform-lab/sessions",
      runtimeRoot: options.runtimeRoot ?? "/run/terraform-lab/slots",
      controlBinary:
        options.controlBinary ?? "/usr/local/sbin/terraform-lab-control",
      controlAbiFile:
        options.controlAbiFile ?? "/etc/terraform-lab/native-control-abi",
      commandTimeoutMs: options.commandTimeoutMs ?? 30_000,
      commandMaxOutputBytes: options.commandMaxOutputBytes ?? 1_048_576,
      maxQueuedOperations: requirePositiveInteger(
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
      throw new NativeRuntimeError(
        "NOT_INITIALIZED",
        "종료된 Terraform 런타임은 다시 사용할 수 없습니다."
      );
    }
    this.initializePromise ??= this.initializeInternal().catch((error) => {
      this.initializePromise = null;
      throw error;
    });
    await this.initializePromise;
  }

  async getOrCreate(id: string): Promise<LabSessionInfo> {
    requireSafeSessionId(id);
    return this.toInfo(await this.getOrCreateRecord(id));
  }

  async get(id: string): Promise<LabSessionInfo | null> {
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

  async reset(id: string): Promise<LabSessionInfo> {
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

  async extend(id: string, additionalMs: number): Promise<LabSessionInfo> {
    requireSafeSessionId(id);
    requirePositiveInteger("additionalMs", additionalMs, 24 * 60 * 60 * 1_000);
    await this.initialize();
    return this.withLock(async () => {
      const record = this.sessions.get(id);
      if (!record || record.expiresAt <= Date.now() || !(await this.isReady(record))) {
        if (record) await this.destroyRecord(record);
        throw new NativeRuntimeError(
          "SESSION_UNAVAILABLE",
          "연장할 활성 Terraform 실습 세션을 찾을 수 없습니다."
        );
      }
      const maximumExpiry = Date.now() + 24 * 60 * 60 * 1_000;
      const expiresAt = Math.min(record.expiresAt + additionalMs, maximumExpiry);
      if (expiresAt <= record.expiresAt) return this.toInfo(record);
      await this.control([
        "extend",
        record.slot,
        record.generation,
        String(expiresAt)
      ]);
      const extended = { ...record, expiresAt };
      this.sessions.set(id, extended);
      return this.toInfo(extended);
    });
  }

  async execute(
    id: string,
    argv: readonly string[],
    options: NativeCommandOptions
  ): Promise<NativeCommandResult> {
    requireSafeSessionId(id);
    if (
      argv.length === 0
      || argv.some((item) => typeof item !== "string" || item.includes("\u0000"))
    ) {
      throw new NativeRuntimeError(
        "COMMAND_FAILED",
        "실행할 Terraform 검증 명령 인자가 올바르지 않습니다."
      );
    }
    if (
      (options.operation !== "verify" && options.operation !== "skip")
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.stepId)
    ) {
      throw new NativeRuntimeError(
        "COMMAND_FAILED",
        "Terraform 검증 작업 계약이 올바르지 않습니다."
      );
    }
    const session = await this.getOrCreateRecord(id);
    const timeoutMs = Math.min(
      Math.max(250, options.timeoutMs ?? this.options.commandTimeoutMs),
      60_000
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
        "Terraform 정리 주기는 10초 이상의 정수여야 합니다."
      );
    }
    if (!this.janitor) {
      this.janitor = setInterval(() => {
        void this.cleanupExpired().catch((error) => {
          console.error(
            "Native Terraform session cleanup failed:",
            (error as Error).message
          );
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.stopJanitor();
    this.closed = true;
    this.initialized = false;
    this.sessions.clear();
    await this.releaseProcessLock();
  }

  private async initializeInternal(): Promise<void> {
    const installedAbi = await fs.readFile(
      this.options.controlAbiFile,
      "utf8"
    ).then((value) => value.trim()).catch((error) => {
      throw new NativeRuntimeError(
        "RUNTIME_MISCONFIGURED",
        "Terraform 네이티브 제어 ABI 파일을 읽을 수 없습니다.",
        { cause: error }
      );
    });
    if (installedAbi !== NATIVE_CONTROL_ABI) {
      throw new NativeRuntimeError(
        "RUNTIME_MISCONFIGURED",
        "애플리케이션과 Terraform 네이티브 제어 도구의 ABI가 일치하지 않습니다."
      );
    }
    await fs.access(this.options.controlBinary, fs.constants.X_OK).catch((error) => {
      throw new NativeRuntimeError(
        "RUNTIME_MISCONFIGURED",
        `Terraform 네이티브 제어 도구를 실행할 수 없습니다: ${this.options.controlBinary}`,
        { cause: error }
      );
    });
    await fs.mkdir(this.options.runtimeRoot, { recursive: true, mode: 0o750 });
    await this.acquireProcessLock();
    try {
      for (const slot of this.slotNames()) {
        const record = await this.readSlot(slot);
        if (!record) {
          // Empty slots still have a strict runtime-directory contract. Running
          // prepare here makes service readiness cover the first-login path and
          // cleans persistent workspace data after /run is reset by a reboot.
          await this.control(["prepare", slot]);
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

  private async getOrCreateRecord(id: string): Promise<TerraformSessionRecord> {
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

  private async createRecord(
    id: string,
    preferredSlot?: string
  ): Promise<TerraformSessionRecord> {
    if (this.sessions.size >= this.options.maxSessions) {
      throw new NativeRuntimeError(
        "CAPACITY",
        "현재 Terraform 실습 환경이 모두 사용 중입니다."
      );
    }
    const usedSlots = new Set(
      [...this.sessions.values()].map((record) => record.slot)
    );
    const slot = preferredSlot
      && SLOT_PATTERN.test(preferredSlot)
      && !usedSlots.has(preferredSlot)
      ? preferredSlot
      : this.slotNames().find((candidate) => !usedSlots.has(candidate));
    if (!slot) {
      throw new NativeRuntimeError(
        "CAPACITY",
        "사용 가능한 Terraform 네이티브 슬롯이 없습니다."
      );
    }
    const createdAt = Date.now();
    const record: TerraformSessionRecord = {
      version: METADATA_VERSION,
      id,
      generation: createSessionId(),
      slot,
      createdAt,
      expiresAt: createdAt + this.options.sessionTtlMs
    };
    try {
      await this.control(["prepare", slot]);
      await this.writeSlot(record);
      if (!(await this.isReady(record))) {
        throw new NativeRuntimeError(
          "SESSION_UNAVAILABLE",
          "Terraform 슬롯의 보안 계약을 확인하지 못했습니다."
        );
      }
      this.sessions.set(id, record);
      return record;
    } catch (error) {
      await this.control(["prepare", slot]).catch(() => undefined);
      if (error instanceof NativeRuntimeError) throw error;
      throw new NativeRuntimeError(
        "SESSION_UNAVAILABLE",
        "네이티브 Terraform 실습 환경을 시작하지 못했습니다.",
        { cause: error }
      );
    }
  }

  private async destroyRecord(record: TerraformSessionRecord): Promise<void> {
    this.sessions.delete(record.id);
    await this.control(["prepare", record.slot]);
  }

  private async cleanupExpiredLocked(): Promise<number> {
    const expired = [...this.sessions.values()].filter(
      (record) => record.expiresAt <= Date.now()
    );
    for (const record of expired) await this.destroyRecord(record);
    return expired.length;
  }

  private async readSlot(slot: string): Promise<TerraformSessionRecord | null> {
    const slotDirectory = this.slotDirectory(slot);
    try {
      const [metadataText, sessionIdText, expiresAtText] = await Promise.all([
        fs.readFile(path.join(slotDirectory, "metadata.json"), "utf8"),
        fs.readFile(path.join(slotDirectory, "session-id"), "utf8"),
        fs.readFile(path.join(slotDirectory, "expires-at"), "utf8")
      ]);
      const value: unknown = JSON.parse(metadataText);
      const generation = sessionIdText.trim();
      const expiresAt = Number(expiresAtText.trim());
      if (
        !isRecord(value)
        || value.version !== METADATA_VERSION
        || !isSafeSessionId(value.id)
        || typeof value.generation !== "string"
        || !GENERATION_PATTERN.test(value.generation)
        || value.generation !== generation
        || value.slot !== slot
        || typeof value.createdAt !== "number"
        || !Number.isSafeInteger(value.createdAt)
        || typeof value.expiresAt !== "number"
        || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt !== expiresAt
      ) {
        return null;
      }
      return {
        version: METADATA_VERSION,
        id: value.id,
        generation,
        slot,
        createdAt: value.createdAt,
        expiresAt
      };
    } catch {
      return null;
    }
  }

  private async writeSlot(record: TerraformSessionRecord): Promise<void> {
    const slotDirectory = this.slotDirectory(record.slot);
    await this.atomicWrite(
      path.join(slotDirectory, "session-id"),
      `${record.generation}\n`,
      0o640
    );
    await this.atomicWrite(
      path.join(slotDirectory, "expires-at"),
      `${record.expiresAt}\n`,
      0o640
    );
    await this.atomicWrite(
      path.join(slotDirectory, "metadata.json"),
      `${JSON.stringify(record)}\n`,
      0o640
    );
  }

  private async atomicWrite(file: string, value: string, mode: number): Promise<void> {
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
    );
    await fs.writeFile(temporary, value, {
      encoding: "utf8",
      mode,
      flag: "wx"
    });
    try {
      await fs.chmod(temporary, mode);
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async isReady(record: TerraformSessionRecord): Promise<boolean> {
    const result = await this.runControl(
      ["probe", record.slot, record.generation, String(record.expiresAt)],
      5_000,
      64 * 1_024
    ).catch(() => null);
    return result?.code === 0;
  }

  private async control(args: readonly string[]): Promise<void> {
    const result = await this.runControl(args, 30_000, 256 * 1_024);
    if (result.code !== 0) {
      const detail = sanitizeOutput(result.stderr).trim();
      throw new NativeRuntimeError(
        "SESSION_UNAVAILABLE",
        detail
          ? `Terraform 네이티브 런타임 제어 실패: ${detail}`
          : "Terraform 네이티브 런타임 제어에 실패했습니다."
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
      let killTimer: NodeJS.Timeout | null = null;
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
        if (killTimer) clearTimeout(killTimer);
        reject(new NativeRuntimeError(
          "COMMAND_FAILED",
          "Terraform 네이티브 제어 프로세스를 시작하지 못했습니다.",
          { cause: error }
        ));
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          truncated
        });
      });
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        killTimer.unref();
      }, timeoutMs);
      timer.unref();
    });
  }

  private terminalChannel(
    child: ChildProcessWithoutNullStreams
  ): NativeTerminalChannel {
    let closed = false;
    child.once("error", () => undefined);
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const close = () => {
      if (closed) return;
      closed = true;
      child.stdin.end();
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      }, 1_000);
      forceTimer.unref();
    };
    return {
      output: child.stdout,
      errorOutput: child.stderr,
      input: child.stdin,
      pid: child.pid,
      write: (data) => (
        !closed && child.stdin.writable ? child.stdin.write(data) : false
      ),
      close,
      kill: (signal = "SIGTERM") => {
        closed = true;
        child.kill(signal);
      },
      exited
    };
  }

  private toInfo(record: TerraformSessionRecord): LabSessionInfo {
    return {
      id: record.id,
      slot: record.slot,
      address: `native://terraform/${record.slot}`,
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
      throw new NativeRuntimeError(
        "RUNTIME_MISCONFIGURED",
        "내부 Terraform 슬롯 ID가 안전하지 않습니다."
      );
    }
    return path.join(this.options.runtimeRoot, slot);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queuedOperations >= this.options.maxQueuedOperations) {
      throw new NativeRuntimeError(
        "CAPACITY",
        "Terraform 실습 환경 요청이 많습니다. 잠시 후 다시 시도해 주세요."
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
          "다른 Terraform Lab 런타임 프로세스가 슬롯을 관리하고 있습니다."
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
      // Missing lock is already effectively released.
    }
    this.processLockNonce = null;
  }
}
