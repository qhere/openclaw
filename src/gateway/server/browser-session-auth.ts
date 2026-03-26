/**
 * Shared auth helpers for Phase 5 browser-session endpoints (T2 and T3).
 *
 * Delegates to `safeEqualSecret` so timing-safe token comparison lives in one
 * canonical place and both callers (browser-session-ws.ts,
 * routes/browser-sessions.ts) stay in sync automatically.
 */

import { safeEqualSecret } from "../../security/secret-equal.js";

/**
 * Timing-safe comparison of two gateway tokens.
 *
 * Delegates to `safeEqualSecret` (SHA-256 + timingSafeEqual) so the security-
 * critical implementation lives in one place.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  return safeEqualSecret(provided, expected);
}
