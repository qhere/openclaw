/**
 * T2: OpenClaw internal CDP WebSocket endpoint
 *
 * Attaches a WebSocket.Server (noServer mode) to the existing http.Server.
 * Handles upgrade requests for paths matching /api/browser-sessions/:id/cdp.
 *
 * Security:
 *   - Authenticates via x-openclaw-token header using timingSafeEqual
 *     (SHA-256 hex digests — always 64 bytes, so lengths always match)
 *   - Proxies only explicitly allowlisted CDP methods in each direction
 *   - Closes with code 4403 for any disallowed method from client
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { CDPSession } from "playwright-core";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { pendingSessionsMap } from "../../agents/tools/human-browser-login-tool.js";
import { tokenMatches } from "./browser-session-auth.js";

// ---------------------------------------------------------------------------
// CDP method allowlists
// ---------------------------------------------------------------------------

/** Methods the viewer/client is allowed to send to Chrome via this proxy. */
export const CDP_ALLOWED_FROM_CLIENT: readonly string[] = [
  "Page.startScreencast",
  "Page.screencastFrameAck",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
] as const;

/** Events from Chrome that are forwarded to the viewer/client. */
export const CDP_ALLOWED_FROM_CHROME: readonly string[] = [
  "Page.screencastFrame",
  "Page.screencastStopped",
  "Page.frameNavigated",
  "Page.loadEventFired",
  "Page.domContentEventFired",
  "Page.javascriptDialogOpening",
] as const;

const CDP_PATH_RE = /^\/api\/browser-sessions\/([^/]+)\/cdp$/;

// ---------------------------------------------------------------------------
// Write an HTTP error response to a raw socket (for upgrade rejections)
// ---------------------------------------------------------------------------

function writeHttpError(socket: Socket, statusCode: number, statusText: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function attachBrowserSessionCdpWs(opts: {
  server: HttpServer;
  wss: WebSocketServer;
  openclawGatewayToken: string;
}): void {
  const { server, wss, openclawGatewayToken } = opts;

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? "/";
    const match = CDP_PATH_RE.exec(url);

    // Not our path — let other upgrade handlers process it
    if (!match) {
      return;
    }

    const sessionId = match[1];

    // Auth check
    const providedToken = req.headers["x-openclaw-token"] as string | undefined;
    if (!tokenMatches(providedToken, openclawGatewayToken)) {
      writeHttpError(socket, 401, "Unauthorized");
      return;
    }

    // Session lookup
    const entry = pendingSessionsMap.get(sessionId);
    if (!entry) {
      writeHttpError(socket, 404, "Not Found");
      return;
    }

    // Upgrade the connection
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      handleCdpConnection(ws, entry.cdpSession);
    });
  });
}

// ---------------------------------------------------------------------------
// Per-connection handler
// ---------------------------------------------------------------------------

function handleCdpConnection(ws: WebSocket, cdpSession: CDPSession): void {
  // Map of event name → listener function so we can remove them on cleanup
  const cdpListeners = new Map<string, (params: unknown) => void>();

  // Forward allowed Chrome events → client
  // Cast to `any` for event name because playwright-core types only allow
  // known Protocol.Events keys, but our allowlisted events are valid CDP events.
  for (const eventName of CDP_ALLOWED_FROM_CHROME) {
    const listener = (params: unknown) => {
      try {
        ws.send(JSON.stringify({ method: eventName, params }));
      } catch {
        // ignore send errors on closed socket
      }
    };
    cdpListeners.set(eventName, listener);
    // oxlint-disable-next-line typescript/no-explicit-any
    (cdpSession as { on: (event: string, listener: (p: unknown) => void) => void }).on(
      eventName,
      listener,
    );
  }

  // Forward allowed client messages → CDP session
  ws.on("message", (data: unknown) => {
    let method: string;
    let params: Record<string, unknown>;

    try {
      const parsed = JSON.parse(String(data)) as {
        method?: string;
        params?: Record<string, unknown>;
      };
      method = typeof parsed.method === "string" ? parsed.method : "";
      params = typeof parsed.params === "object" && parsed.params !== null ? parsed.params : {};
    } catch {
      ws.close(4403, "invalid_json");
      return;
    }

    // Method allowlist check
    if (!(CDP_ALLOWED_FROM_CLIENT as string[]).includes(method)) {
      ws.send(JSON.stringify({ error: "method_not_allowed", method }));
      ws.close(4403, "method_not_allowed");
      return;
    }

    // Forward to CDP
    void cdpSession.send(method as Parameters<CDPSession["send"]>[0], params).catch(() => {
      // Ignore CDP send errors (e.g., target closed)
    });
  });

  // Cleanup on client disconnect
  ws.on("close", () => {
    // Remove all CDP event listeners
    for (const [eventName, listener] of cdpListeners.entries()) {
      // oxlint-disable-next-line typescript/no-explicit-any
      (cdpSession as { off: (event: string, listener: (p: unknown) => void) => void }).off(
        eventName,
        listener,
      );
    }
    cdpListeners.clear();

    // Detach the CDP session
    void cdpSession.detach().catch(() => {
      // Ignore if already detached
    });
  });
}
