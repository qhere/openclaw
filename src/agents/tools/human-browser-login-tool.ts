import type { CDPSession, Page } from "playwright-core";
import { jsonResult, type AnyAgentTool } from "./common.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingSessionEntry = {
  resolve: () => void;
  reject: (err: Error) => void;
  cdpSession: CDPSession;
  resolved: boolean;
  /** runId that created this session, used for dedup */
  runId: string;
  /** Promise that resolves/rejects when the session completes */
  promise: Promise<void>;
};

// ---------------------------------------------------------------------------
// Module-level map shared with T2/T3 (same process, in-memory)
// ---------------------------------------------------------------------------

export const pendingSessionsMap = new Map<string, PendingSessionEntry>();

// ---------------------------------------------------------------------------
// Helpers — resolveSession / rejectSession
// ---------------------------------------------------------------------------

/**
 * Resolves a pending browser session, unblocking the tool execute() call.
 * Returns false if sessionId is not found or already resolved.
 */
export function resolveSession(sessionId: string): boolean {
  const entry = pendingSessionsMap.get(sessionId);
  if (!entry || entry.resolved) {
    return false;
  }
  entry.resolved = true;
  entry.resolve();
  return true;
}

/**
 * Rejects a pending browser session with an error.
 * Returns false if sessionId is not found or already resolved.
 */
export function rejectSession(sessionId: string, err: Error): boolean {
  const entry = pendingSessionsMap.get(sessionId);
  if (!entry || entry.resolved) {
    return false;
  }
  entry.resolved = true;
  entry.reject(err);
  return true;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class BrowserSessionTimeoutError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Browser session ${sessionId} timed out`);
    this.name = "BrowserSessionTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export function createHumanBrowserLoginTool(opts: {
  paperclipApiUrl: string;
  openclawGatewayToken: string;
  sessionTimeoutMs?: number;
  /** Injected fetch for testing; defaults to global fetch */
  _fetch?: typeof fetch;
  /** Injected page getter for testing */
  _getPage?: () => Promise<Page>;
}): AnyAgentTool {
  const {
    paperclipApiUrl,
    openclawGatewayToken,
    sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  } = opts;

  const fetchFn = opts._fetch ?? fetch;
  const getPage =
    opts._getPage ??
    (async (): Promise<Page> => {
      throw new Error(
        "request_human_browser_login: no _getPage provider configured. " +
          "Pass _getPage when creating the tool in a Playwright-backed browser context.",
      );
    });

  return {
    label: "Human Browser Login",
    name: "request_human_browser_login",
    description:
      "Pause the agent and hand off the current browser page to a human for manual login. " +
      "The agent resumes automatically when the human confirms login is complete. " +
      "Use this when authentication requires human interaction (captcha, 2FA, SSO, etc.).",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Current run ID (from agent context).",
        },
        agentId: {
          type: "string",
          description: "Agent ID.",
        },
        companyId: {
          type: "string",
          description: "Company/tenant ID.",
        },
        issueId: {
          type: "string",
          description: "Optional issue ID this run is working on.",
        },
        reason: {
          type: "string",
          description: "Human-readable reason why login is needed.",
        },
      },
      required: ["runId", "agentId", "companyId", "reason"],
    },

    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const runId = typeof params.runId === "string" ? params.runId : "";
      const agentId = typeof params.agentId === "string" ? params.agentId : "";
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const issueId = typeof params.issueId === "string" ? params.issueId : undefined;
      const reason = typeof params.reason === "string" ? params.reason : "";

      // Dedup: if this runId already has an active session, piggyback on it
      for (const [existingSessionId, entry] of pendingSessionsMap.entries()) {
        if (entry.runId === runId && !entry.resolved) {
          // Wait on the same underlying promise
          await entry.promise;
          return jsonResult({ sessionId: existingSessionId, status: "resumed" });
        }
      }

      // Get the current page from the browser context
      const page = await getPage();
      const currentUrl = page.url();

      // Call Paperclip webhook to register the session
      const webhookResponse = await fetchFn(
        `${paperclipApiUrl}/api/internal/browser-session-request`,
        {
          method: "POST",
          headers: {
            "x-openclaw-token": openclawGatewayToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId,
            agentId,
            companyId,
            ...(issueId !== undefined ? { issueId } : {}),
            url: currentUrl,
            reason,
          }),
        },
      );

      if (!webhookResponse.ok) {
        throw new Error(`Paperclip browser-session-request failed: HTTP ${webhookResponse.status}`);
      }

      const { sessionId } = (await webhookResponse.json()) as { sessionId: string };

      // Create a CDP session for the current page
      const cdpSession = await page.context().newCDPSession(page);

      // Build the entry with a promise/resolve/reject triple.
      // Local vars use distinct names to avoid shadowing the module-level
      // resolveSession / rejectSession exports.
      let resolvePromise!: () => void;
      let rejectPromise!: (err: Error) => void;

      const promise = new Promise<void>((res, rej) => {
        resolvePromise = res;
        rejectPromise = rej;
      });
      // Attach a noop catch so the rejection is never "unhandled" before our
      // try/await below has a chance to see it.
      promise.catch(() => {});

      const entry: PendingSessionEntry = {
        resolve: resolvePromise,
        reject: rejectPromise,
        cdpSession,
        resolved: false,
        runId,
        promise,
      };

      pendingSessionsMap.set(sessionId, entry);

      // Set up timeout
      const timer = setTimeout(() => {
        rejectSession(sessionId, new BrowserSessionTimeoutError(sessionId));
      }, sessionTimeoutMs);

      try {
        await promise;
      } finally {
        clearTimeout(timer);
        // Detach the CDP session if the T2 handler never connected (e.g. timeout
        // or rejection before any client joined).  The T2 ws-close handler also
        // calls detach(), so we swallow errors here for the double-detach case.
        if (!entry.resolved) {
          try {
            await cdpSession.detach();
          } catch {
            // Already detached — ignore
          }
        }
        // Remove the entry so completed sessions do not accumulate indefinitely
        // in the map (prevents memory leak in long-running processes).
        pendingSessionsMap.delete(sessionId);
      }

      return jsonResult({ sessionId, status: "resumed" });
    },
  };
}
