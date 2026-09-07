import type { LabRuntime } from "./course-definition.js";
import { pathToFileURL } from "node:url";
import type { Step } from "./curriculum.js";
import {
  NativeRuntimeError,
  createSessionId,
  isExactVerifierResult,
  type NativeCommandResult,
  type NativeTerminalChannel
} from "./native-runtime.js";
import { terraformSteps } from "./terraform-curriculum.js";
import { NativeTerraformRuntime } from "./terraform-runtime.js";

const EXPECTED_STEP_COUNT = 34;
const COMMAND_TIMEOUT_MS = 60_000;
const TERMINAL_EXIT_TIMEOUT_MS = 5_000;
const MAX_TERMINAL_OUTPUT_BYTES = 4 * 1_048_576;
const TERMINAL_TAIL_BYTES = 16 * 1_024;
const SMOKE_MODE = process.env.TERRAFORM_SMOKE_MODE || "full";

type SmokeRuntime = Pick<
  LabRuntime,
  | "getOrCreate"
  | "reset"
  | "destroy"
  | "execute"
  | "openTerminal"
  | "close"
>;

type SmokePhase =
  | "contract"
  | "learner-command"
  | "validator"
  | "skip-setup"
  | "skip-validator"
  | "skip-next-command"
  | "skip-next-validator"
  | "interrupted";

class CurriculumSmokeError extends Error {
  readonly stepId: string;
  readonly phase: SmokePhase;

  constructor(stepId: string, phase: SmokePhase, detail: string) {
    super(`${phase}/${stepId}: ${detail}`);
    this.name = "CurriculumSmokeError";
    this.stepId = stepId;
    this.phase = phase;
  }
}

let requestedSignal: NodeJS.Signals | null = null;
let activeTerminal: NativeTerminalChannel | null = null;

function requestShutdown(signal: NodeJS.Signals): void {
  requestedSignal ??= signal;
  activeTerminal?.kill("SIGTERM");
}

function throwIfInterrupted(stepId: string): void {
  if (requestedSignal) {
    throw new CurriculumSmokeError(
      stepId,
      "interrupted",
      `received ${requestedSignal}`
    );
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function assertCurriculumContract(steps: readonly Step[]): void {
  if (steps.length !== EXPECTED_STEP_COUNT) {
    throw new CurriculumSmokeError(
      "curriculum",
      "contract",
      `expected ${EXPECTED_STEP_COUNT} steps, received ${steps.length}`
    );
  }
  const ids = new Set<string>();
  for (const step of steps) {
    const expectedMarker = `verified:${step.id}`;
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(step.id)
      || ids.has(step.id)
      || step.expect.length !== 1
      || step.expect[0] !== expectedMarker
      || step.validate.length < 1
      || step.skipSetup.length < 1
    ) {
      throw new CurriculumSmokeError(
        step.id || "unknown",
        "contract",
        "invalid step id, marker, or trusted argv contract"
      );
    }
    ids.add(step.id);
  }
}

function assertExactResult(
  step: Step,
  phase: Exclude<
    SmokePhase,
    "contract" | "learner-command" | "skip-next-command" | "interrupted"
  >,
  result: NativeCommandResult
): void {
  if (!isExactVerifierResult(step.id, result)) {
    throw new CurriculumSmokeError(
      step.id,
      phase,
      `exit=${result.code}, truncated=${result.truncated}, exactMarker=false`
    );
  }
}

async function closeTerminal(terminal: NativeTerminalChannel): Promise<void> {
  terminal.close();
  const exited = await Promise.race([
    terminal.exited.then(() => true),
    wait(TERMINAL_EXIT_TIMEOUT_MS).then(() => false)
  ]);
  if (!exited) {
    terminal.kill("SIGKILL");
    await Promise.race([
      terminal.exited.then(() => undefined),
      wait(TERMINAL_EXIT_TIMEOUT_MS)
    ]);
  }
}

async function runLearnerCommand(
  runtime: SmokeRuntime,
  sessionId: string,
  step: Step,
  phase: "learner-command" | "skip-next-command"
): Promise<void> {
  throwIfInterrupted(step.id);
  if (!runtime.openTerminal) {
    throw new CurriculumSmokeError(
      step.id,
      phase,
      "native terminal API is unavailable"
    );
  }

  const terminal = await runtime.openTerminal(sessionId);
  activeTerminal = terminal;
  const nonce = createSessionId();
  const sentinel = `__TFLAB_SMOKE_${nonce}__`;
  const statusVariable = `__tflab_smoke_status_${nonce}`;
  const payload = [
    step.command,
    `${statusVariable}=$?`,
    `printf '\\n${sentinel}:%s\\n' "$${statusVariable}"`,
    "exit"
  ].join("\n") + "\n";
  const sentinelPattern = new RegExp(
    `(?:^|\\r?\\n)${sentinel}:([0-9]{1,3})\\r?(?:\\n|$)`
  );

  let outputBytes = 0;
  let outputTail = "";
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  let resolveCompletion!: (status: number) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<number>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const settleFailure = (detail: string) => {
    if (settled) return;
    settled = true;
    rejectCompletion(new CurriculumSmokeError(step.id, phase, detail));
  };
  const consume = (chunk: Buffer | string) => {
    if (settled) return;
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += value.length;
    if (outputBytes > MAX_TERMINAL_OUTPUT_BYTES) {
      settleFailure("terminal output exceeded the bounded capture limit");
      return;
    }
    outputTail = `${outputTail}${value.toString("utf8")}`.slice(
      -TERMINAL_TAIL_BYTES
    );
    const match = sentinelPattern.exec(outputTail);
    if (!match) return;
    settled = true;
    resolveCompletion(Number(match[1]));
  };
  const onOutput = (chunk: Buffer | string) => consume(chunk);
  const onErrorOutput = (chunk: Buffer | string) => consume(chunk);
  terminal.output.on("data", onOutput);
  terminal.errorOutput.on("data", onErrorOutput);
  void terminal.exited.then(({ code, signal }) => {
    settleFailure(
      `terminal exited before completion (code=${code ?? "null"}, signal=${signal ?? "none"})`
    );
  });
  timeout = setTimeout(() => {
    settleFailure(`learner command exceeded ${COMMAND_TIMEOUT_MS}ms`);
  }, COMMAND_TIMEOUT_MS);
  timeout.unref();

  try {
    terminal.write(payload);
    const status = await completion;
    if (status !== 0) {
      throw new CurriculumSmokeError(
        step.id,
        phase,
        `learner command exited with status ${status}`
      );
    }
    throwIfInterrupted(step.id);
  } finally {
    if (timeout) clearTimeout(timeout);
    terminal.output.off("data", onOutput);
    terminal.errorOutput.off("data", onErrorOutput);
    await closeTerminal(terminal);
    if (activeTerminal === terminal) activeTerminal = null;
  }
}

async function runTrustedStep(
  runtime: SmokeRuntime,
  sessionId: string,
  step: Step,
  operation: "verify" | "skip",
  phase: "validator" | "skip-setup" | "skip-validator" | "skip-next-validator"
): Promise<void> {
  throwIfInterrupted(step.id);
  const argv = operation === "skip" ? step.skipSetup : step.validate;
  const result = await runtime.execute(sessionId, argv, {
    operation,
    stepId: step.id,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_TERMINAL_OUTPUT_BYTES
  });
  assertExactResult(step, phase, result);
  throwIfInterrupted(step.id);
}

async function cleanupSession(
  runtime: SmokeRuntime,
  sessionId: string
): Promise<void> {
  try {
    await runtime.destroy(sessionId);
  } catch {
    // A failed installer is retried only after the native installer prepares slots.
  }
}

export async function runCurriculumSmoke(
  runtime: SmokeRuntime,
  steps: readonly Step[] = terraformSteps
): Promise<void> {
  assertCurriculumContract(steps);
  const canonicalSessionId = createSessionId();
  const sessionIds = new Set([canonicalSessionId]);
  while (sessionIds.size < 3) sessionIds.add(createSessionId());
  const [, evenSkipSessionId, oddSkipSessionId] = [...sessionIds];

  try {
    await runtime.getOrCreate(canonicalSessionId);
    for (const [index, step] of steps.entries()) {
      console.log(
        `Terraform curriculum smoke: canonical ${index + 1}/${steps.length} ${step.id}`
      );
      await runLearnerCommand(
        runtime,
        canonicalSessionId,
        step,
        "learner-command"
      );
      await runTrustedStep(
        runtime,
        canonicalSessionId,
        step,
        "verify",
        "validator"
      );
    }
    await cleanupSession(runtime, canonicalSessionId);

    for (const [label, sessionId, skipParity] of [
      ["even-skip", evenSkipSessionId, 0],
      ["odd-skip", oddSkipSessionId, 1]
    ] as const) {
      await runtime.getOrCreate(sessionId);
      for (const [index, step] of steps.entries()) {
        const shouldSkip = index % 2 === skipParity;
        console.log(
          `Terraform curriculum smoke: ${label} ${index + 1}/${steps.length} ${step.id}`
        );
        if (shouldSkip) {
          await runTrustedStep(
            runtime,
            sessionId,
            step,
            "skip",
            "skip-setup"
          );
        } else {
          await runLearnerCommand(
            runtime,
            sessionId,
            step,
            "skip-next-command"
          );
        }
        await runTrustedStep(
          runtime,
          sessionId,
          step,
          "verify",
          shouldSkip ? "skip-validator" : "skip-next-validator"
        );
      }
      await cleanupSession(runtime, sessionId);
    }
  } finally {
    if (activeTerminal) {
      activeTerminal.kill("SIGTERM");
      activeTerminal = null;
    }
    for (const sessionId of sessionIds) {
      await cleanupSession(runtime, sessionId);
    }
    await runtime.close();
  }
}

export async function runFirstSessionSmoke(
  runtime: SmokeRuntime,
  step: Step = terraformSteps[0]
): Promise<void> {
  const sessionId = createSessionId();
  try {
    await runtime.getOrCreate(sessionId);
    await runLearnerCommand(runtime, sessionId, step, "learner-command");
    await runTrustedStep(runtime, sessionId, step, "verify", "validator");
  } finally {
    if (activeTerminal) {
      activeTerminal.kill("SIGTERM");
      activeTerminal = null;
    }
    await cleanupSession(runtime, sessionId);
    await runtime.close();
  }
}

async function main(): Promise<void> {
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  const runtime = new NativeTerraformRuntime({
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    commandMaxOutputBytes: MAX_TERMINAL_OUTPUT_BYTES
  });
  try {
    if (SMOKE_MODE === "first-session") {
      await runFirstSessionSmoke(runtime);
      console.log("Terraform first-session smoke passed: session, terminal, and verifier ready.");
    } else if (SMOKE_MODE === "full") {
      await runCurriculumSmoke(runtime);
      console.log(
        `Terraform curriculum smoke passed: ${terraformSteps.length} canonical and skip transitions verified.`
      );
    } else {
      throw new CurriculumSmokeError(
        "curriculum",
        "contract",
        `unsupported smoke mode ${SMOKE_MODE}`
      );
    }
  } catch (error) {
    if (error instanceof CurriculumSmokeError) {
      console.error(`Terraform curriculum smoke failed: ${error.message}`);
    } else if (error instanceof NativeRuntimeError) {
      console.error(`Terraform curriculum smoke failed: native runtime ${error.code}`);
    } else {
      console.error("Terraform curriculum smoke failed: unexpected runtime error");
    }
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
