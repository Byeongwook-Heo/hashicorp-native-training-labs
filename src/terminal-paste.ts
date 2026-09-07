export function terminalPastePayload(command: string, execute = false) {
  const normalized = command.replace(/\r\n?/g, "\n");
  return `\x15\x1b[200~${normalized}\x1b[201~${execute ? "\r" : ""}`;
}
