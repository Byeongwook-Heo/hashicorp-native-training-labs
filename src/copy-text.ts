function copyWithSelection(value: string): boolean {
  const focused = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -10000px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } finally {
    textarea.remove();
    try {
      focused?.focus({ preventScroll: true });
    } catch {
      // Focus restoration must never turn a successful copy into a failure.
    }
  }
}

/** Start both clipboard mechanisms while the original click is still active. */
export async function copyText(value: string): Promise<void> {
  let clipboardWrite: Promise<void> | undefined;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      // Start the standards-based write before moving focus to the fallback
      // textarea. Managed browser shells can otherwise lose user activation.
      clipboardWrite = navigator.clipboard.writeText(value);
    } catch {
      // A synchronous browser denial can still fall back to selection copy.
    }
  }

  let selectionCopied = false;
  try {
    selectionCopied = copyWithSelection(value);
  } catch {
    // Continue to the secure-context Clipboard API path.
  }

  if (clipboardWrite) {
    try {
      await clipboardWrite;
      return;
    } catch (error) {
      if (!selectionCopied) throw error;
    }
  }
  if (selectionCopied) return;
  throw new Error("브라우저가 복사를 허용하지 않았습니다.");
}
