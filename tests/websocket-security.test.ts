import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { WebSocket } from "ws";

const workspace = process.cwd();
const adminEmail = "ws-admin@example.com";
const adminPassword = "WebSocketAdmin!123";
let child: ChildProcess | undefined;
let baseUrl = "";
let wsUrl = "";
let serverOutput = "";

async function availablePort() {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("test port allocation failed");
  }
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child?.exitCode !== null) {
      throw new Error(`mock server exited early:\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`mock server did not become healthy:\n${serverOutput}`);
}

async function login() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
    }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not return a session cookie");
  return setCookie.split(";")[0];
}

function openTerminal(cookie: string, origin = baseUrl) {
  const socket = new WebSocket(wsUrl, {
    headers: {
      Cookie: cookie,
      Origin: origin,
    },
  });
  return new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("websocket terminal ready timed out")),
      3_000,
    );
    socket.once("message", (data) => {
      clearTimeout(timer);
      if (!data.toString().includes("Vault Native Lab")) {
        reject(new Error("websocket terminal banner was invalid"));
        return;
      }
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForClose(socket: WebSocket) {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("websocket close timed out")),
      3_000,
    );
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    socket.on("error", () => undefined);
  });
}

beforeAll(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vault-ws-security-"));
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/terminal`;
  child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        MOCK_LAB: "true",
        AUTH_COOKIE_SECRET:
          "websocket-test-auth-secret-with-at-least-32-bytes",
        LAB_SESSION_SECRET:
          "websocket-test-session-secret-with-at-least-32-bytes",
        AUTH_COOKIE_SECURE: "false",
        LAB_STORE_PATH: path.join(directory, "store.json"),
        LAB_ADMIN_EMAIL: adminEmail,
        LAB_ADMIN_PASSWORD: adminPassword,
        MAX_SESSIONS: "2",
        WS_INPUT_BYTES_PER_SECOND: "1024",
        WS_INPUT_BURST_BYTES: String(32 * 1024),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (data: Buffer) => {
    serverOutput += data.toString("utf8").slice(0, 4_000);
  });
  child.stderr?.on("data", (data: Buffer) => {
    serverOutput += data.toString("utf8").slice(0, 4_000);
  });
  await waitForHealth();
}, 10_000);

afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      resolve();
    }, 3_000);
    child?.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
});

describe("terminal websocket security", () => {
  it("keeps exactly one terminal per user and replaces an older connection", async () => {
    const cookie = await login();
    const first = await openTerminal(cookie);
    const firstClosed = waitForClose(first);

    const second = await openTerminal(cookie);
    await expect(firstClosed).resolves.toBe(4410);
    expect(second.readyState).toBe(WebSocket.OPEN);
    second.close();
  });

  it("closes an authenticated terminal immediately on logout", async () => {
    const cookie = await login();
    const socket = await openTerminal(cookie);
    const closed = waitForClose(socket);

    const response = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: baseUrl,
      },
    });
    expect(response.status).toBe(204);
    await expect(closed).resolves.toBe(4401);
  });

  it("closes a client that exceeds the bounded input burst", async () => {
    const cookie = await login();
    const socket = await openTerminal(cookie);
    const closed = waitForClose(socket);
    const payload = Buffer.alloc(60 * 1024, 0x61);
    socket.send(payload);
    await expect(closed).resolves.toBe(4429);
  });

  it("rejects a cross-origin terminal handshake", async () => {
    const cookie = await login();
    const socket = new WebSocket(wsUrl, {
      headers: {
        Cookie: cookie,
        Origin: "https://attacker.example",
      },
    });
    await expect(waitForClose(socket)).resolves.toBe(4403);
  });
});
