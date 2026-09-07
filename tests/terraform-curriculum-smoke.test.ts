import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LabSessionInfo } from "../server/course-definition.js";
import type {
  NativeCommandOptions,
  NativeCommandResult,
  NativeTerminalChannel
} from "../server/native-runtime.js";
import { terraformSteps } from "../server/terraform-curriculum.js";
import { runCurriculumSmoke } from "../server/terraform-curriculum-smoke.js";

const sessionInfo = (id: string): LabSessionInfo => ({
  id,
  slot: "s01",
  address: "native://terraform/s01",
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  remainingMs: 60_000
});

function successfulTerminal(): NativeTerminalChannel {
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const input = new PassThrough();
  let finished = false;
  let resolveExit!: (
    value: { code: number | null; signal: NodeJS.Signals | null }
  ) => void;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (signal: NodeJS.Signals | null = null) => {
    if (finished) return;
    finished = true;
    output.end();
    errorOutput.end();
    input.end();
    resolveExit({ code: signal ? null : 0, signal });
  };

  return {
    output,
    errorOutput,
    input,
    write(data) {
      const match = Buffer.from(data).toString("utf8").match(
        /(__TFLAB_SMOKE_[a-f0-9]{32}__)/
      );
      if (!match) return false;
      queueMicrotask(() => output.write(`\r\n${match[1]}:0\r\n`));
      return true;
    },
    close: () => finish(),
    kill: (signal = "SIGTERM") => finish(signal),
    exited
  };
}

function createRuntime(failFirstValidation = false) {
  let validationCount = 0;
  const execute = vi.fn(async (
    _id: string,
    _argv: readonly string[],
    options: NativeCommandOptions
  ): Promise<NativeCommandResult> => {
    if (options.operation === "verify") validationCount += 1;
    const failed = failFirstValidation
      && options.operation === "verify"
      && validationCount === 1;
    const stdout = failed ? "not-verified\n" : `verified:${options.stepId}\n`;
    return {
      code: failed ? 1 : 0,
      stdout,
      stderr: "",
      output: stdout,
      truncated: false
    };
  });
  return {
    getOrCreate: vi.fn(async (id: string) => sessionInfo(id)),
    reset: vi.fn(async (id: string) => sessionInfo(id)),
    destroy: vi.fn(async () => true),
    execute,
    openTerminal: vi.fn(async () => successfulTerminal()),
    close: vi.fn(async () => undefined)
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Terraform native curriculum smoke", () => {
  it("covers every command, every skip, and both skip-to-next parities", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runtime = createRuntime();

    await runCurriculumSmoke(runtime, terraformSteps);

    expect(runtime.getOrCreate).toHaveBeenCalledTimes(3);
    expect(runtime.openTerminal).toHaveBeenCalledTimes(terraformSteps.length * 2);
    expect(runtime.execute).toHaveBeenCalledTimes(terraformSteps.length * 4);
    expect(runtime.reset).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();

    const skipIds = runtime.execute.mock.calls
      .filter(([, , options]) => options.operation === "skip")
      .map(([, , options]) => options.stepId);
    expect(skipIds).toHaveLength(terraformSteps.length);
    expect(new Set(skipIds)).toEqual(
      new Set(terraformSteps.map((step) => step.id))
    );
    expect(
      runtime.execute.mock.calls.filter(
        ([, , options]) => options.operation === "verify"
      )
    ).toHaveLength(terraformSteps.length * 3);
  });

  it("fails closed on a non-exact marker and still releases the runtime", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runtime = createRuntime(true);

    await expect(runCurriculumSmoke(runtime, terraformSteps)).rejects.toThrow(
      "exactMarker=false"
    );
    expect(runtime.destroy).toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});
