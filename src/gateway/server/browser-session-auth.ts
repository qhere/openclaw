/**
 * Shared auth helpers for Phase 5 browser-session endpoints (T2 and T3).
 *
 * Extracted so the identical sha256/tokenMatches logic lives in one place
 * and the two callers (browser-session-ws.ts, routes/browser-sessions.ts)
 * stay in sync automatically.
 */

import { createHash, timingSafeEqual } from "node:crypto";

function sha256digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/**
 * Timing-safe comparison of two gateway tokens.
 *
 * Both inputs are hashed with SHA-256 before comparison so the buffers are
 * always 32 bytes — a requirement for `timingSafeEqual`.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string") {
    return false;
  }
  return timingSafeEqual(sha256digest(provided), sha256digest(expected));
}
