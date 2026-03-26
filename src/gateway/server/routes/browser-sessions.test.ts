/**
 * T3 tests: POST /api/browser-sessions/:id/resume
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock pendingSessionsMap, resolveSession from T1
// ---------------------------------------------------------------------------

const pendingSessionsMock = new Map<
  string,
  {
    resolve: () => void;
    reject: (err: Error) => void;
    cdpSession: unknown;
    resolved: boolean;
    runId: string;
  }
>();

const resolveSessionMock = vi.fn((id: string): boolean => {
  const entry = pendingSessionsMock.get(id);
  if (!entry || entry.resolved) {
    return false;
  }
  entry.resolved = true;
  entry.resolve();
  return true;
});

vi.mock("../../../agents/tools/human-browser-login-tool.js", () => ({
  pendingSessionsMap: pendingSessionsMock,
  resolveSession: resolveSessionMock,
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { createBrowserSessionsRouter } = await import("./browser-sessions.js");

// ---------------------------------------------------------------------------
// Minimal request/response mock for testing (avoids spinning up real Express)
// ---------------------------------------------------------------------------

type MockReq = {
  method: string;
  url: string;
  params: Record<string, string>;
  headers: Record<string, string>;
};

type MockRes = {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (data: unknown) => void;
  end: () => void;
};

function createMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
    },
    end() {},
  };
  return res;
}

// ---------------------------------------------------------------------------
// Helper: call the resume handler directly
// ---------------------------------------------------------------------------

const GATEWAY_TOKEN = "the-correct-token";
const WRONG_TOKEN = "nope";

async function callResume(opts: {
  sessionId: string;
  token?: string;
}): Promise<{ status: number; body: unknown }> {
  const router = createBrowserSessionsRouter({ openclawGatewayToken: GATEWAY_TOKEN });

  const req: MockReq = {
    method: "POST",
    url: `/api/browser-sessions/${opts.sessionId}/resume`,
    params: { id: opts.sessionId },
    headers: opts.token !== undefined ? { "x-openclaw-token": opts.token } : {},
  };

  const res = createMockRes();

  // Find the POST /:id/resume handler
  await router.handleResume(
    req as unknown as Parameters<typeof router.handleResume>[0],
    res as unknown as Parameters<typeof router.handleResume>[1],
  );

  return { status: res.statusCode, body: res.body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/browser-sessions/:id/resume", () => {
  beforeEach(() => {
    pendingSessionsMock.clear();
    resolveSessionMock.mockClear();
  });

  // -------------------------------------------------------------------------
  // 1. Missing token → 401
  // -------------------------------------------------------------------------
  it("returns 401 when x-openclaw-token header is missing", async () => {
    const { status, body } = await callResume({ sessionId: "sess-1" });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: "unauthorized" });
  });

  // -------------------------------------------------------------------------
  // 2. Wrong token → 401
  // -------------------------------------------------------------------------
  it("returns 401 when x-openclaw-token is wrong", async () => {
    const { status, body } = await callResume({ sessionId: "sess-1", token: WRONG_TOKEN });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: "unauthorized" });
  });

  // -------------------------------------------------------------------------
  // 3. Unknown session id → 404
  // -------------------------------------------------------------------------
  it("returns 404 when sessionId is not in pendingSessionsMap", async () => {
    const { status, body } = await callResume({ sessionId: "unknown-sess", token: GATEWAY_TOKEN });
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: "not_found" });
  });

  // -------------------------------------------------------------------------
  // 4. Valid id → resolves Promise, returns 200 {ok: true}
  // -------------------------------------------------------------------------
  it("resolves the session and returns 200 {ok: true}", async () => {
    let resolved = false;
    pendingSessionsMock.set("sess-good", {
      resolve: () => {
        resolved = true;
      },
      reject: vi.fn(),
      cdpSession: {},
      resolved: false,
      runId: "run-1",
    });

    const { status, body } = await callResume({ sessionId: "sess-good", token: GATEWAY_TOKEN });

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(resolveSessionMock).toHaveBeenCalledWith("sess-good");
    expect(resolved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Already-resolved id → 409 {error: "already_resolved"}
  // -------------------------------------------------------------------------
  it("returns 409 when session is already resolved", async () => {
    pendingSessionsMock.set("sess-done", {
      resolve: vi.fn(),
      reject: vi.fn(),
      cdpSession: {},
      resolved: true,
      runId: "run-2",
    });

    const { status, body } = await callResume({ sessionId: "sess-done", token: GATEWAY_TOKEN });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "already_resolved" });
  });
});
