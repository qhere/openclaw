/**
 * T2 tests: OpenClaw internal CDP WebSocket endpoint
 * Path: /api/browser-sessions/:id/cdp
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock pendingSessionsMap from T1
// ---------------------------------------------------------------------------

const mockCdpSession = {
  on: vi.fn(),
  off: vi.fn(),
  send: vi.fn(async () => ({ result: "ok" })),
  detach: vi.fn(async () => {}),
};

const pendingSessionsMock = new Map<
  string,
  {
    resolve: () => void;
    reject: (err: Error) => void;
    cdpSession: typeof mockCdpSession;
    resolved: boolean;
    runId: string;
  }
>();

vi.mock("../../agents/tools/human-browser-login-tool.js", () => ({
  pendingSessionsMap: pendingSessionsMock,
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

const { attachBrowserSessionCdpWs, CDP_ALLOWED_FROM_CLIENT, CDP_ALLOWED_FROM_CHROME } =
  await import("./browser-session-ws.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const GATEWAY_TOKEN = "test-gateway-secret-token-abcdef";
const WRONG_TOKEN = "wrong-token";

/** sha256 hex digest helper — same as the implementation */
function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Creates a minimal mock http.Server with 'upgrade' event support.
 */
function createMockHttpServer() {
  const ee = new EventEmitter();
  return ee as unknown as import("node:http").Server;
}

/**
 * Simulate an HTTP upgrade request.
 * Returns a mock socket with write/destroy spies and a mock WebSocket client.
 */
function createUpgradeContext(opts: { path: string; token?: string }) {
  const req = {
    url: opts.path,
    headers: {
      upgrade: "websocket",
      ...(opts.token !== undefined ? { "x-openclaw-token": opts.token } : {}),
    },
    socket: { remoteAddress: "127.0.0.1" },
  };

  const socket = {
    write: vi.fn(),
    destroy: vi.fn(),
  };

  const head = Buffer.alloc(0);

  return { req, socket, head };
}

/**
 * Simulates a WebSocket client connection (ws side).
 */
class MockWsClient extends EventEmitter {
  public sentMessages: string[] = [];
  public closeCalled: Array<{ code: number; reason?: string }> = [];

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(code: number, reason?: string) {
    this.closeCalled.push({ code, reason });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attachBrowserSessionCdpWs", () => {
  beforeEach(() => {
    pendingSessionsMock.clear();
    mockCdpSession.on.mockReset();
    mockCdpSession.off.mockReset();
    mockCdpSession.send.mockReset();
    mockCdpSession.detach.mockReset();
    mockCdpSession.send.mockResolvedValue({ result: "ok" });
  });

  // -------------------------------------------------------------------------
  // 1. Auth: missing token → 401
  // -------------------------------------------------------------------------
  it("rejects upgrade with 401 when x-openclaw-token is missing", async () => {
    const server = createMockHttpServer();
    const wss = new EventEmitter() as unknown as import("ws").WebSocketServer;
    (wss as unknown as { handleUpgrade: ReturnType<typeof vi.fn> }).handleUpgrade = vi.fn();

    attachBrowserSessionCdpWs({ server, wss, openclawGatewayToken: GATEWAY_TOKEN });

    const { req, socket, head } = createUpgradeContext({
      path: "/api/browser-sessions/sess-1/cdp",
    });
    server.emit("upgrade", req, socket, head);
    await new Promise((r) => setImmediate(r));

    expect(socket.destroy).toHaveBeenCalled();
    const written = socket.write.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(written).toContain("401");
  });

  // -------------------------------------------------------------------------
  // 2. Auth: wrong token → 401
  // -------------------------------------------------------------------------
  it("rejects upgrade with 401 when x-openclaw-token is wrong", async () => {
    const server = createMockHttpServer();
    const wss = new EventEmitter() as unknown as import("ws").WebSocketServer;
    (wss as unknown as { handleUpgrade: ReturnType<typeof vi.fn> }).handleUpgrade = vi.fn();

    attachBrowserSessionCdpWs({ server, wss, openclawGatewayToken: GATEWAY_TOKEN });

    const { req, socket, head } = createUpgradeContext({
      path: "/api/browser-sessions/sess-1/cdp",
      token: WRONG_TOKEN,
    });
    server.emit("upgrade", req, socket, head);
    await new Promise((r) => setImmediate(r));

    expect(socket.destroy).toHaveBeenCalled();
    const written = socket.write.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(written).toContain("401");
  });

  // -------------------------------------------------------------------------
  // 3. Session not found → 404
  // -------------------------------------------------------------------------
  it("rejects upgrade with 404 when sessionId not in pendingSessionsMap", async () => {
    const server = createMockHttpServer();
    const wss = new EventEmitter() as unknown as import("ws").WebSocketServer;
    (wss as unknown as { handleUpgrade: ReturnType<typeof vi.fn> }).handleUpgrade = vi.fn();

    attachBrowserSessionCdpWs({ server, wss, openclawGatewayToken: GATEWAY_TOKEN });

    const { req, socket, head } = createUpgradeContext({
      path: "/api/browser-sessions/nonexistent-session/cdp",
      token: GATEWAY_TOKEN,
    });
    server.emit("upgrade", req, socket, head);
    await new Promise((r) => setImmediate(r));

    expect(socket.destroy).toHaveBeenCalled();
    const written = socket.write.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(written).toContain("404");
  });

  // -------------------------------------------------------------------------
  // 4. Allowed CDP method → cdpSession.send() called
  // -------------------------------------------------------------------------
  it("forwards allowed client method to cdpSession.send()", async () => {
    const sessionId = "sess-allowed";
    pendingSessionsMock.set(sessionId, {
      resolve: vi.fn(),
      reject: vi.fn(),
      cdpSession: mockCdpSession as never,
      resolved: false,
      runId: "run-1",
    });

    const server = createMockHttpServer();
    let capturedWs: MockWsClient | null = null;

    const wss = new EventEmitter() as unknown as import("ws").WebSocketServer;
    (
      wss as unknown as {
        handleUpgrade: (
          req: unknown,
          socket: unknown,
          head: unknown,
          cb: (ws: MockWsClient) => void,
        ) => void;
      }
    ).handleUpgrade = (req, socket, head, cb) => {
      capturedWs = new MockWsClient();
      cb(capturedWs);
    };

    attachBrowserSessionCdpWs({ server, wss, openclawGatewayToken: GATEWAY_TOKEN });

    const { req, socket, head } = createUpgradeContext({
      path: `/api/browser-sessions/${sessionId}/cdp`,
      token: GATEWAY_TOKEN,
    });
    server.emit("upgrade", req, socket, head);
    await new Promise((r) => setImmediate(r));

    expect(socket.destroy).not.toHaveBeenCalled();
    expect(capturedWs).not.toBeNull();

    // Simulate client sending an allowed method
    const message = JSON.stringify({ method: "Page.startScreencast", params: { format: "jpeg" } });
    capturedWs!.emit("message", message);

    await new Promise((r) => setImmediate(r));

    expect(mockCdpSession.send).toHaveBeenCalledWith("Page.startScreencast", { format: "jpeg" });
  });

  // -------------------------------------------------------------------------
  // 5. CDP event from session → stringified JSON sent to client
  // -------------------------------------------------------------------------
  it("forwards CDP events from session to client as JSON", async () => {
    const sessionId = "sess-events";
    pendingSessionsMock.set(sessionId, {
      resolve: vi.fn(),
      reject: vi.fn(),
      cdpSession: mockCdpSession as never,
      resolved: false,
      runId: "run-2",
    });

    const server = createMockHttpServer();
    let capturedWs: MockWsClient | null = null;
    const eventListeners: Map<string, (params: unknown) => void> = new Map();

    // Capture cdpSession.on calls so we can fire them manually
    mockCdpSession.on.mockImplementation((event: string, cb: (params: unknown) => void) => {
      eventListeners.set(event, cb);
    });

    const wss = new EventEmitter() as unknown as import("ws").WebSocketServer;
    (
      wss as unknown as {
        handleUpgrade: (
          req: unknown,
          socket: unknown,
          head: unknown,
          cb: (ws: MockWsClient) => void,
        ) => void;
      }
    ).handleUpgrade = (req, socket, head, cb) => {
      capturedWs = new MockWsClient();
      cb(capturedWs);
    };

    attachBrowserSessionCdpWs({ server, wss, openclawGatewayToken: GATEWAY_TOKEN });

    const { req, socket, head } = createUpgradeContext({
      path: `/api/browser-sessions/${sessionId}/cdp`,
      token: GATEWAY_TOKEN,
    });
    server.emit("upgrade", req, socket, head);
    await new Promise((r) => setImmediate(r));

    // Simulate a CDP event arriving from Chrome
    const frameData = { frameId: "frame-1", url: "https://example.com" };
    const cb = eventListeners.get("Page.frameNavigated");
    expect(cb).toBeDefined();
    cb!(frameData);

    await new Promise((r) => setImmediate(r));

    expect(capturedWs!.sentMessages.length).toBeGreaterThan(0);
    const sent = JSON.parse(capturedWs!.sentMessages[0]) as { method: string; params: unknown };
    expect(sent).toMatchObject({ method: "Page.frameNavigated", params: frameData });
  });

  // -------------------------------------------------------------------------
  // 6. Disallowed method → close 4403
  // -------------------------------------------------------------------------
  it("closes connection with code 4403 for disallowed CDP method", async () => {
    const sessionId = "sess-blocked";
    pendingSessionsMock.set(sessionId, {
      resolve: vi.fn(),
      reject: vi.fn(),
      cdpSession: mockCdpSession as never,
      resolved: false,
      runId: "run-3",
    });

    const server = createMockHttpServer();
    let capturedWs: MockWsClient | null = null;

    const wss = new EventEmitter() as unknown as import("ws").WebSocketServer;
    (
      wss as unknown as {
        handleUpgrade: (
          req: unknown,
          socket: unknown,
          head: unknown,
          cb: (ws: MockWsClient) => void,
        ) => void;
      }
    ).handleUpgrade = (req, socket, head, cb) => {
      capturedWs = new MockWsClient();
      cb(capturedWs);
    };

    attachBrowserSessionCdpWs({ server, wss, openclawGatewayToken: GATEWAY_TOKEN });

    const { req, socket, head } = createUpgradeContext({
      path: `/api/browser-sessions/${sessionId}/cdp`,
      token: GATEWAY_TOKEN,
    });
    server.emit("upgrade", req, socket, head);
    await new Promise((r) => setImmediate(r));

    // Send a disallowed method
    capturedWs!.emit(
      "message",
      JSON.stringify({ method: "Runtime.evaluate", params: { expression: "1+1" } }),
    );

    await new Promise((r) => setImmediate(r));

    expect(capturedWs!.closeCalled.length).toBeGreaterThan(0);
    expect(capturedWs!.closeCalled[0].code).toBe(4403);

    // cdpSession.send should NOT have been called
    expect(mockCdpSession.send).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Client disconnect → cdpSession.detach() + listeners removed
  // -------------------------------------------------------------------------
  it("detaches cdpSession and removes listeners on client disconnect", async () => {
    const sessionId = "sess-disconnect";
    pendingSessionsMock.set(sessionId, {
      resolve: vi.fn(),
      reject: vi.fn(),
      cdpSession: mockCdpSession as never,
      resolved: false,
      runId: "run-4",
    });

    const server = createMockHttpServer();
    let capturedWs: MockWsClient | null = null;

    const wss = new EventEmitter() as unknown as import("ws").WebSocketServer;
    (
      wss as unknown as {
        handleUpgrade: (
          req: unknown,
          socket: unknown,
          head: unknown,
          cb: (ws: MockWsClient) => void,
        ) => void;
      }
    ).handleUpgrade = (req, socket, head, cb) => {
      capturedWs = new MockWsClient();
      cb(capturedWs);
    };

    attachBrowserSessionCdpWs({ server, wss, openclawGatewayToken: GATEWAY_TOKEN });

    const { req, socket, head } = createUpgradeContext({
      path: `/api/browser-sessions/${sessionId}/cdp`,
      token: GATEWAY_TOKEN,
    });
    server.emit("upgrade", req, socket, head);
    await new Promise((r) => setImmediate(r));

    // Simulate client disconnect
    capturedWs!.emit("close");
    await new Promise((r) => setImmediate(r));

    expect(mockCdpSession.detach).toHaveBeenCalled();
    // off() called for each CDP_ALLOWED_FROM_CHROME event
    expect(mockCdpSession.off).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. CDP_ALLOWED_FROM_CLIENT and CDP_ALLOWED_FROM_CHROME lists exported
  // -------------------------------------------------------------------------
  it("exports the correct CDP method allowlists", () => {
    expect(CDP_ALLOWED_FROM_CLIENT).toEqual([
      "Page.startScreencast",
      "Page.screencastFrameAck",
      "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent",
      "Input.insertText",
    ]);

    expect(CDP_ALLOWED_FROM_CHROME).toEqual([
      "Page.screencastFrame",
      "Page.screencastStopped",
      "Page.frameNavigated",
      "Page.loadEventFired",
      "Page.domContentEventFired",
      "Page.javascriptDialogOpening",
    ]);
  });
});

// Sanity-check that sha256hex used in timingSafeEqual works as expected
describe("timing-safe equality (sanity check)", () => {
  it("sha256 hex of same input produces same 64-char output", () => {
    const a = sha256hex("secret");
    const b = sha256hex("secret");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("sha256 hex of different inputs differs", () => {
    expect(sha256hex("a")).not.toBe(sha256hex("b"));
  });
});
