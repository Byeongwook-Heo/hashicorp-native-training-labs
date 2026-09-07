const BRACKETED_PASTE = /\x1b\[200~[\s\S]*?\x1b\[201~/g;

export function containsTerminalExecution(input: string): boolean {
  const controlInput = input.replace(BRACKETED_PASTE, "");
  return controlInput.includes("\r") || controlInput.includes("\n");
}
