import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSessionTimeoutError,
  createHumanBrowserLoginTool,
  pendingSessionsMap,
  rejectSession,
  resolveSession,
} from "./human-browser-login-tool.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCdpSession = {
  on: vi.fn(),
  send: vi.fn(),
  detach: vi.fn(),
  off: vi.fn(),
};

const mockPage = {
  url: vi.fn(() => "https://example.com/login"),
  context: vi.fn(() => ({
    newCDPSession: vi.fn(async () => mockCdpSession),
  })),
};

// Mock playwright-core CDPSession type — the tool imports Page from playwright-core
// so we mock the browser context module.
const browserClientMocks = vi.hoisted(() => ({
  browserStatus: vi.fn(async () => ({
    ok: true,
    running: true,
    cdpPort: 9222,
    cdpUrl: "http://127.0.0.1:9222",
  })),
}));

// The tool needs to get the "current page". We'll mock the browser client module
// used by the tool to retrieve the page object.
vi.mock("../../browser/client.js", () => browserClientMocks);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetch(
  response: { sessionId: string; status?: number } = { sessionId: "sess-abc-123" },
) {
  return vi.fn(async (_url: string, _opts: RequestInit) => ({
    ok: true,
    status: response.status ?? 200,
    json: async () => ({ sessionId: response.sessionId }),
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHumanBrowserLoginTool", () => {
  beforeEach(() => {
    pendingSessionsMap.clear();
    vi.useFakeTimers();
    mockPage.url.mockReturnValue("https://example.com/login");
    mockCdpSession.on.mockReset();
    mockCdpSession.send.mockReset();
    mockCdpSession.detach.mockReset();
  });

  afterEach(() => {
    pendingSessionsMap.clear();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Webhook call + sessionId returned from Paperclip
  // -------------------------------------------------------------------------
  it("calls Paperclip webhook with correct body and registers in pendingSessionsMap", async () => {
    const fetchSpy = makeFetch({ sessionId: "sess-001" });
    const tool = createHumanBrowserLoginTool({
      paperclipApiUrl: "http://paperclip:3100",
      openclawGatewayToken: "gateway-secret-token",
      _fetch: fetchSpy as unknown as typeof fetch,
      _getPage: async () => mockPage as unknown as import("playwright-core").Page,
    });

    // Start execute but don't await — it blocks until resolveSession is called
    const executePromise = tool.execute("call-1", {
      runId: "run-xyz",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "Need to log in to example.com",
    });

    // Let the microtask queue drain so the fetch and CDPSession creation happen
    // (multiple rounds to handle promise chains inside execute)
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Webhook was called with correct args
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, reqInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://paperclip:3100/api/internal/browser-session-request");
    const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      runId: "run-xyz",
      agentId: "agent-1",
      companyId: "company-1",
      reason: "Need to log in to example.com",
      url: "https://example.com/login",
    });
    expect(reqInit.headers).toMatchObject({
      "x-openclaw-token": "gateway-secret-token",
      "content-type": "application/json",
    });

    // Session registered in the map
    expect(pendingSessionsMap.has("sess-001")).toBe(true);
    const entry = pendingSessionsMap.get("sess-001")!;
    expect(entry.resolved).toBe(false);
    expect(entry.cdpSession).toBe(mockCdpSession);

    // Resolve so the execute promise can settle
    resolveSession("sess-001");
    const result = await executePromise;
    expect((result.details as { sessionId?: string })?.sessionId).toBe("sess-001");
  });

  // -------------------------------------------------------------------------
  // 2. Tool blocks until resolveSession is called, then returns "resumed"
  // -------------------------------------------------------------------------
  it("blocks until resolveSession is called, then returns 'resumed'", async () => {
    const fetchSpy = makeFetch({ sessionId: "sess-resume" });
    const tool = createHumanBrowserLoginTool({
      paperclipApiUrl: "http://paperclip:3100",
      openclawGatewayToken: "tok",
      _fetch: fetchSpy as unknown as typeof fetch,
      _getPage: async () => mockPage as unknown as import("playwright-core").Page,
    });

    let settled = false;
    const executePromise = tool.execute("call-2", {
      runId: "run-resume",
      agentId: "agent-1",
      companyId: "co-1",
      reason: "login",
    });
    void executePromise.then(() => {
      settled = true;
    });

    // drain microtasks — fetch + CDPSession creation
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Not settled yet (waiting for human)
    expect(settled).toBe(false);

    // Human completes login — resolve the session
    resolveSession("sess-resume");
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    const result = await executePromise;
    expect(settled).toBe(true);
    const content = result.content?.[0];
    if (content && content.type === "text") {
      expect(content.text).toContain("resumed");
    }
  });

  // -------------------------------------------------------------------------
  // 3. Throws BrowserSessionTimeoutError after configured TTL (real timers)
  // -------------------------------------------------------------------------
  it("throws BrowserSessionTimeoutError after configured TTL", async () => {
    // Use real timers for this test to avoid fake-timer/unhandled-rejection races
    vi.useRealTimers();
    const fetchSpy = makeFetch({ sessionId: "sess-timeout" });
    const TIMEOUT_MS = 30; // very short so the test is fast
    const tool = createHumanBrowserLoginTool({
      paperclipApiUrl: "http://paperclip:3100",
      openclawGatewayToken: "tok",
      sessionTimeoutMs: TIMEOUT_MS,
      _fetch: fetchSpy as unknown as typeof fetch,
      _getPage: async () => mockPage as unknown as import("playwright-core").Page,
    });

    const executePromise = tool.execute("call-3", {
      runId: "run-timeout",
      agentId: "agent-1",
      companyId: "co-1",
      reason: "login",
    });

    await expect(executePromise).rejects.toBeInstanceOf(BrowserSessionTimeoutError);
  });

  // -------------------------------------------------------------------------
  // 4. Duplicate call for same runId returns existing sessionId without second webhook call
  // -------------------------------------------------------------------------
  it("duplicate call for same runId returns existing sessionId without second webhook call", async () => {
    const fetchSpy = makeFetch({ sessionId: "sess-dedup" });
    const tool = createHumanBrowserLoginTool({
      paperclipApiUrl: "http://paperclip:3100",
      openclawGatewayToken: "tok",
      _fetch: fetchSpy as unknown as typeof fetch,
      _getPage: async () => mockPage as unknown as import("playwright-core").Page,
    });

    // First call
    const promise1 = tool.execute("call-4a", {
      runId: "run-dedup",
      agentId: "agent-1",
      companyId: "co-1",
      reason: "login",
    });
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Second call with same runId
    const promise2 = tool.execute("call-4b", {
      runId: "run-dedup",
      agentId: "agent-1",
      companyId: "co-1",
      reason: "login",
    });
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Only one webhook call should have been made
    expect(fetchSpy).toHaveBeenCalledOnce();

    // Resolve both by resolving the underlying session
    resolveSession("sess-dedup");
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    const [r1, r2] = await Promise.all([promise1, promise2]);
    // Both should report the same sessionId
    expect((r1.details as { sessionId?: string })?.sessionId).toBe("sess-dedup");
    expect((r2.details as { sessionId?: string })?.sessionId).toBe("sess-dedup");
  });
});

// ---------------------------------------------------------------------------
// resolveSession / rejectSession helpers
// ---------------------------------------------------------------------------

describe("resolveSession", () => {
  beforeEach(() => pendingSessionsMap.clear());
  afterEach(() => pendingSessionsMap.clear());

  it("returns false when session not found", () => {
    expect(resolveSession("unknown")).toBe(false);
  });

  it("returns true and marks resolved when session exists", () => {
    let resolved = false;
    pendingSessionsMap.set("s1", {
      resolve: () => {
        resolved = true;
      },
      reject: () => {},
      cdpSession: mockCdpSession as never,
      resolved: false,
      runId: "r1",
      promise: Promise.resolve(),
    });
    expect(resolveSession("s1")).toBe(true);
    expect(resolved).toBe(true);
    expect(pendingSessionsMap.get("s1")!.resolved).toBe(true);
  });

  it("returns false if already resolved", () => {
    pendingSessionsMap.set("s2", {
      resolve: () => {},
      reject: () => {},
      cdpSession: mockCdpSession as never,
      resolved: true,
      runId: "r2",
      promise: Promise.resolve(),
    });
    expect(resolveSession("s2")).toBe(false);
  });
});

describe("rejectSession", () => {
  beforeEach(() => pendingSessionsMap.clear());
  afterEach(() => pendingSessionsMap.clear());

  it("returns false when session not found", () => {
    expect(rejectSession("unknown", new Error("e"))).toBe(false);
  });

  it("returns true and calls reject when session exists", () => {
    let rejectedWith: Error | null = null;
    pendingSessionsMap.set("s3", {
      resolve: () => {},
      reject: (err) => {
        rejectedWith = err;
      },
      cdpSession: mockCdpSession as never,
      resolved: false,
      runId: "r3",
      promise: Promise.resolve(),
    });
    const err = new Error("boom");
    expect(rejectSession("s3", err)).toBe(true);
    expect(rejectedWith).toBe(err);
    expect(pendingSessionsMap.get("s3")!.resolved).toBe(true);
  });

  it("returns false if already resolved", () => {
    pendingSessionsMap.set("s4", {
      resolve: () => {},
      reject: () => {},
      cdpSession: mockCdpSession as never,
      resolved: true,
      runId: "r4",
      promise: Promise.resolve(),
    });
    expect(rejectSession("s4", new Error("e"))).toBe(false);
  });
});
