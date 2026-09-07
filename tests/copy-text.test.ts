import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../src/copy-text.js";

type CopyHarness = {
  clipboardWrite: ReturnType<typeof vi.fn>;
  execCommand: ReturnType<typeof vi.fn>;
  restoreFocus: ReturnType<typeof vi.fn>;
  textareaFocus: ReturnType<typeof vi.fn>;
  setSelectionRange: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function installCopyHarness(selectionResult: boolean): CopyHarness {
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  const execCommand = vi.fn().mockReturnValue(selectionResult);
  const restoreFocus = vi.fn();
  const textareaFocus = vi.fn();
  const setSelectionRange = vi.fn();
  const remove = vi.fn();
  const textarea = {
    value: "",
    readOnly: false,
    style: {} as CSSStyleDeclaration,
    setAttribute: vi.fn(),
    focus: textareaFocus,
    select: vi.fn(),
    setSelectionRange,
    remove
  };

  vi.stubGlobal("HTMLElement", class HTMLElement {});
  const focused = Object.assign(new HTMLElement(), { focus: restoreFocus });
  vi.stubGlobal("document", {
    activeElement: focused,
    body: { appendChild: vi.fn() },
    createElement: vi.fn().mockReturnValue(textarea),
    execCommand
  });
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWrite } });
  return {
    clipboardWrite,
    execCommand,
    restoreFocus,
    textareaFocus,
    setSelectionRange,
    remove
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("starts the modern and selection paths inside the same activation", async () => {
    const harness = installCopyHarness(true);

    await copyText("terraform version");

    expect(harness.execCommand).toHaveBeenCalledWith("copy");
    expect(harness.clipboardWrite).toHaveBeenCalledWith("terraform version");
    expect(harness.clipboardWrite.mock.invocationCallOrder[0]).toBeLessThan(
      harness.execCommand.mock.invocationCallOrder[0]
    );
    expect(harness.textareaFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(harness.restoreFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it("uses the secure Clipboard API when selection copy is unavailable", async () => {
    const harness = installCopyHarness(false);

    await copyText("terraform plan");

    expect(harness.clipboardWrite).toHaveBeenCalledWith("terraform plan");
    expect(harness.clipboardWrite.mock.invocationCallOrder[0]).toBeLessThan(
      harness.execCommand.mock.invocationCallOrder[0]
    );
  });

  it("preserves exact multiline Unicode text and trailing newlines", async () => {
    const harness = installCopyHarness(false);
    const value = "terraform output -json\n# 결과 확인\n";

    await copyText(value);

    expect(harness.setSelectionRange).toHaveBeenCalledWith(0, value.length);
    expect(harness.clipboardWrite).toHaveBeenCalledWith(value);
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it("falls back after a selection-copy exception", async () => {
    const harness = installCopyHarness(false);
    harness.execCommand.mockImplementation(() => {
      throw new Error("selection copy unavailable");
    });

    await copyText("terraform validate");

    expect(harness.clipboardWrite).toHaveBeenCalledWith("terraform validate");
    expect(harness.remove).toHaveBeenCalledOnce();
  });

  it("does not let focus restoration invalidate a successful copy", async () => {
    const harness = installCopyHarness(true);
    harness.restoreFocus.mockImplementation(() => {
      throw new Error("detached focus target");
    });

    await expect(copyText("terraform test")).resolves.toBeUndefined();
    expect(harness.clipboardWrite).toHaveBeenCalledWith("terraform test");
  });

  it("keeps a successful selection copy when the modern API is denied", async () => {
    const harness = installCopyHarness(true);
    harness.clipboardWrite.mockRejectedValue(new Error("permission denied"));

    await expect(copyText("terraform test")).resolves.toBeUndefined();
    expect(harness.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure when neither copy mechanism is available", async () => {
    installCopyHarness(false);
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", {});

    await expect(copyText("terraform apply")).rejects.toThrow(
      "브라우저가 복사를 허용하지 않았습니다."
    );
  });

  it("propagates a Clipboard API rejection", async () => {
    const harness = installCopyHarness(false);
    harness.clipboardWrite.mockRejectedValue(new Error("permission denied"));

    await expect(copyText("terraform apply")).rejects.toThrow("permission denied");
  });
});
