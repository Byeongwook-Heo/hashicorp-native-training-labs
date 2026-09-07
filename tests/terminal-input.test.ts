import { describe, expect, it } from "vitest";
import { containsTerminalExecution } from "../server/terminal-input.js";

describe("mock terminal execution detection", () => {
  it("does not treat reviewable bracketed paste newlines as Enter", () => {
    expect(containsTerminalExecution(
      "\x15\x1b[200~cat <<'EOF'\nhello\nEOF\x1b[201~",
    )).toBe(false);
  });

  it("detects an explicit Enter outside the bracketed paste", () => {
    expect(containsTerminalExecution(
      "\x15\x1b[200~terraform version\x1b[201~\r",
    )).toBe(true);
    expect(containsTerminalExecution("terraform version\r")).toBe(true);
  });
});
