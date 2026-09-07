import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalPastePayload } from "./terminal-paste.js";

export type TerminalInputResult =
  | { ok: true }
  | { ok: false; reason: "not-connected" | "send-failed" };

export type TerminalInputRequest = {
  command: string;
  execute?: boolean;
  result?: TerminalInputResult;
};

export function Terminal({
  session,
  reconnectKey,
  labName = "Vault Lab"
}: {
  session: string;
  reconnectKey: number;
  labName?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const hostElement = host.current;
    if (!hostElement) return;

    let disposeRuntime: (() => void) | undefined;
    // React StrictMode mounts, cleans up, and mounts effects again in
    // development. Deferring xterm by one frame prevents its internal startup
    // timer from outliving that intentional first cleanup.
    const setupFrame = window.requestAnimationFrame(() => {
      const terminal = new XTerm({
        cursorBlink: true,
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 14,
        lineHeight: 1.42,
        theme: {
          background: "#0c0f12", foreground: "#f4f5f6", cursor: "#a879ff",
          green: "#79e087", brightGreen: "#9cf5a8", magenta: "#a879ff"
        }
      });
      const fit = new FitAddon();
      let disposed = false;
      const fitTerminal = () => {
        if (disposed || !hostElement.isConnected) return;
        fit.fit();
      };
      terminal.loadAddon(fit);
      terminal.open(hostElement);
      fitTerminal();
      terminal.writeln(`\x1b[35m${labName}\x1b[0m 환경에 연결하는 중입니다...\r\n`);
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${location.host}/terminal?session=${session}`);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => terminal.focus();
      socket.onmessage = (event) => {
        if (typeof event.data === "string") terminal.write(event.data);
        else if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
      };
      socket.onclose = () => terminal.writeln("\r\n\x1b[90m터미널 연결이 종료되었습니다.\x1b[0m");
      terminal.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(data));
      const injectCommand = (event: Event) => {
        const detail = (event as CustomEvent<TerminalInputRequest>).detail;
        if (!detail?.command) return;
        if (socket.readyState !== WebSocket.OPEN) {
          detail.result = { ok: false, reason: "not-connected" };
          return;
        }
        try {
          // Bracketed paste keeps multi-line HCL/heredoc commands in readline's
          // edit buffer. The learner can review the whole command before Enter,
          // instead of embedded newlines executing during injection.
          socket.send(terminalPastePayload(detail.command, detail.execute));
          terminal.focus();
          detail.result = { ok: true };
        } catch {
          detail.result = { ok: false, reason: "send-failed" };
        }
      };
      window.addEventListener("training-lab:terminal-input", injectCommand);
      const resize = new ResizeObserver(fitTerminal);
      resize.observe(hostElement);
      disposeRuntime = () => {
        // A queued ResizeObserver notification can run after React has started
        // tearing down xterm. Guard it before disposing the renderer.
        disposed = true;
        resize.disconnect();
        window.removeEventListener("training-lab:terminal-input", injectCommand);
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.close();
        terminal.dispose();
      };
    });

    return () => {
      window.cancelAnimationFrame(setupFrame);
      disposeRuntime?.();
    };
  }, [session, reconnectKey, labName]);
  return <div className="terminal-host" ref={host} />;
}
