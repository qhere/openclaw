/**
 * T3: OpenClaw resume endpoint
 *
 * POST /api/browser-sessions/:id/resume
 *
 * Resolves a pending human-browser-login session, unblocking the
 * waiting agent tool execute() call.
 *
 * Auth: x-openclaw-token header (timingSafeEqual via SHA-256 hex digests)
 *
 * Responses:
 *   200 { ok: true }         — session resolved
 *   401 { error: "unauthorized" }
 *   404 { error: "not_found" }
 *   409 { error: "already_resolved" }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  pendingSessionsMap,
  resolveSession,
} from "../../../agents/tools/human-browser-login-tool.js";
import { tokenMatches } from "../browser-session-auth.js";

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

const RESUME_PATH_RE = /^\/api\/browser-sessions\/([^/]+)\/resume$/;

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export type BrowserSessionsRouter = {
  /**
   * Handles POST /api/browser-sessions/:id/resume.
   * Can be used with raw Node http or Express-compatible middleware.
   */
  handleResume: (
    req: Pick<IncomingMessage, "headers"> & { params?: Record<string, string>; url?: string },
    res: Pick<ServerResponse, "statusCode"> & {
      status?: (code: number) => unknown;
      json?: (data: unknown) => void;
      end?: () => void;
    },
  ) => Promise<void>;

  /**
   * Returns true if the raw http request matches this router's path and
   * the handler was invoked. For integration with the main http request loop.
   */
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
};

export function createBrowserSessionsRouter(opts: {
  openclawGatewayToken: string;
}): BrowserSessionsRouter {
  const { openclawGatewayToken } = opts;

  async function handleResume(
    req: Pick<IncomingMessage, "headers"> & { params?: Record<string, string>; url?: string },
    res: Pick<ServerResponse, "statusCode"> & {
      status?: (code: number) => unknown;
      json?: (data: unknown) => void;
      end?: () => void;
    },
  ): Promise<void> {
    // Auth
    const providedToken = req.headers["x-openclaw-token"] as string | undefined;
    if (!tokenMatches(providedToken, openclawGatewayToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    // Resolve session id from Express params or from URL
    const sessionId =
      (req as { params?: Record<string, string> }).params?.id ??
      RESUME_PATH_RE.exec(req.url ?? "")?.[1];

    if (!sessionId) {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }

    // Check the session state before calling resolveSession
    const entry = pendingSessionsMap.get(sessionId);
    if (!entry) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (entry.resolved) {
      sendJson(res, 409, { error: "already_resolved" });
      return;
    }

    // Resolve it
    const ok = resolveSession(sessionId);
    if (!ok) {
      // Race condition: resolved between our check and call — return 409
      sendJson(res, 409, { error: "already_resolved" });
      return;
    }

    sendJson(res, 200, { ok: true });
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== "POST") {
      return false;
    }
    const url = req.url ?? "";
    if (!RESUME_PATH_RE.test(url)) {
      return false;
    }
    await handleResume(req, res);
    return true;
  }

  return { handleResume, handleRequest };
}

// ---------------------------------------------------------------------------
// Shared JSON response helper
// ---------------------------------------------------------------------------

function sendJson(
  res: Pick<ServerResponse, "statusCode"> & {
    status?: (code: number) => unknown;
    json?: (data: unknown) => void;
    end?: () => void;
  },
  statusCode: number,
  body: unknown,
): void {
  // Express-style response (status().json())
  if (typeof res.status === "function" && typeof res.json === "function") {
    (res.status as (code: number) => { json: (data: unknown) => void })(statusCode).json(body);
    return;
  }

  // Raw Node.js http response
  const rawRes = res as ServerResponse;
  rawRes.statusCode = statusCode;
  rawRes.setHeader("content-type", "application/json; charset=utf-8");
  rawRes.end(JSON.stringify(body));
}
