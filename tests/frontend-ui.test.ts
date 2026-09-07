import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminDashboard } from "../src/AdminDashboard.js";
import { Login } from "../src/Login.js";
import { terminalPastePayload } from "../src/terminal-paste.js";
import viteConfig from "../vite.config.js";

describe("frontend course and navigation contracts", () => {
  it("injects multi-line commands as one reviewable bracketed paste", () => {
    const payload = terminalPastePayload("cat <<'EOF'\r\nhello\r\nEOF");

    expect(payload).toBe("\x15\x1b[200~cat <<'EOF'\nhello\nEOF\x1b[201~");
    expect(payload.endsWith("\r")).toBe(false);
    expect(terminalPastePayload("terraform version", true)).toBe(
      "\x15\x1b[200~terraform version\x1b[201~\r"
    );
  });

  it("describes the complete 30-step Audit and PKI course on login", () => {
    const markup = renderToStaticMarkup(createElement(Login));

    expect(markup).toContain("7개 랩 · 30단계");
    expect(markup).toContain("감사·장애 대응");
    expect(markup).toContain("PKI 인증서 자동화");
  });

  it("renders the Terraform deployment identity from public course metadata", () => {
    const markup = renderToStaticMarkup(createElement(Login, {
      course: {
        id: "terraform-foundations",
        title: "HashiCorp Terraform 실무 기초",
        summary: "HCL부터 안전한 운영 워크플로까지 실습합니다.",
        level: "초급–중급",
        durationMinutes: 225,
        runtimeKind: "terraform-native",
        labCount: 8,
        stepCount: 34
      }
    }));

    expect(markup).toContain("Terraform Lab");
    expect(markup).toContain("HashiCorp Terraform 실무 기초");
    expect(markup).toContain("8개 랩 · 34단계");
    expect(markup).toContain("약 225분");
    expect(markup).not.toContain("PKI 인증서 자동화");
  });

  it("keeps lab return and sign-out controls in the mobile admin header", () => {
    const markup = renderToStaticMarkup(createElement(AdminDashboard, {
      onOpenLab: vi.fn(),
      onSignedOut: vi.fn()
    }));

    expect(markup).toContain('aria-label="실습 화면으로 돌아가기"');
    expect(markup).toContain('aria-label="로그아웃"');
  });

  it("uses the selected course identity in the admin shell", () => {
    const markup = renderToStaticMarkup(createElement(AdminDashboard, {
      labName: "Terraform Lab",
      brandMark: "T",
      onOpenLab: vi.fn(),
      onSignedOut: vi.fn()
    }));

    expect(markup).toContain("Terraform Lab");
  });
});

describe("Vite development proxy origin contract", () => {
  it("rewrites HTTP and WebSocket origins only inside the development proxy", () => {
    const config = typeof viteConfig === "function"
      ? viteConfig({ command: "serve", mode: "test", isSsrBuild: false, isPreview: false })
      : viteConfig;
    const proxy = config.server?.proxy;
    const api = proxy?.["/api"];
    const terminal = proxy?.["/terminal"];

    expect(api).toMatchObject({ target: "http://localhost:3000", changeOrigin: true });
    expect(terminal).toMatchObject({ target: "ws://localhost:3000", changeOrigin: true, ws: true });

    const apiHandlers = new Map<string, (request: { setHeader: (name: string, value: string) => void }) => void>();
    const terminalHandlers = new Map<string, (request: { setHeader: (name: string, value: string) => void }) => void>();
    (api as Exclude<typeof api, string>).configure?.({
      on: (event: string, handler: (request: { setHeader: (name: string, value: string) => void }) => void) => {
        apiHandlers.set(event, handler);
      }
    } as never, {} as never);
    (terminal as Exclude<typeof terminal, string>).configure?.({
      on: (event: string, handler: (request: { setHeader: (name: string, value: string) => void }) => void) => {
        terminalHandlers.set(event, handler);
      }
    } as never, {} as never);

    const apiSetHeader = vi.fn();
    const terminalSetHeader = vi.fn();
    apiHandlers.get("proxyReq")?.({ setHeader: apiSetHeader });
    terminalHandlers.get("proxyReqWs")?.({ setHeader: terminalSetHeader });

    expect(apiSetHeader).toHaveBeenCalledWith("origin", "http://localhost:3000");
    expect(terminalSetHeader).toHaveBeenCalledWith("origin", "http://localhost:3000");
  });
});
