# 57-Claws OpenClaw Fork Customizations

> **Purpose:** Tracks every 57-Claws-specific change made to the OpenClaw fork.
> An AI agent or developer must follow this guide to reapply changes after merging an upstream release.
>
> **Upstream repo:** https://github.com/openclaw/openclaw
> **Fork repo:** https://github.com/qhere/openclaw
> **Last updated:** 2026-03-26
> **Milestone:** Phase 5 — Human-in-the-Loop Browser Handoff (T1–T3)

---

## How to use this guide

After merging a new upstream tag into `main`:

1. Run the `57claws-sync-build.yml` CI workflow — it verifies that Phase 5 files survived.
2. If any `[FAIL]` appears in the verification step, use **Section 3 (New Files)** to recreate missing files and **Section 4 (Modified Files)** to reapply patches.
3. Add and commit the restored files, then re-run the workflow.

---

## 1. Environment Variables

These must be set in the OpenClaw container (`docker-compose.yml` or `.env`):

| Variable                      | Value                   | Required?      | Purpose                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PAPERCLIP_API_URL`  | `http://paperclip:3100` | Yes (for tool) | Paperclip server base URL for webhook calls                                                                                                                                                                                                                                                                   |
| `OPENCLAW_GATEWAY_TOKEN`      | `<shared-secret>`       | Yes (for tool) | Shared auth token between OpenClaw ↔ Paperclip; must match `OPENCLAW_GATEWAY_TOKEN` in Paperclip                                                                                                                                                                                                              |
| `OPENCLAW_TRUST_BACKEND_AUTH` | `"true"`                | Yes (Docker)   | Allows Paperclip on Docker bridge network to authenticate without loopback check. **Security:** bypasses origin/loopback protections — only use on internal Docker networks; never expose this gateway to the internet with this flag set. Requires strict shared-secret rotation (`OPENCLAW_GATEWAY_TOKEN`). |

If `OPENCLAW_PAPERCLIP_API_URL` or `OPENCLAW_GATEWAY_TOKEN` is missing, the `request_human_browser_login` tool is silently omitted — no error, no crash.

> **Known limitation — `_getPage` requirement:** `createHumanBrowserLoginTool` internally calls `_getPage()` to obtain a Playwright `Page` for CDP session creation. The current `createOpenClawTools` registration in `openclaw-tools.ts` does not pass `_getPage`, so the tool will throw `"no _getPage provider configured"` if the model invokes it in a gateway-only deployment without a Playwright-backed browser context. This is by design for Phase 5 of the 57-Claws roadmap — a future phase will wire `_getPage` through the sandbox browser bridge. Until then, only register this tool in environments where the agent already has an active Playwright browser session.

---

## 2. Changes Overview

| File                                                         | Change Type | Phase       | Purpose                                                                   |
| ------------------------------------------------------------ | ----------- | ----------- | ------------------------------------------------------------------------- |
| `Dockerfile`                                                 | Modified    | Pre-Phase 5 | Add python3 + pip + beautifulsoup4 + requests                             |
| `src/agents/tools/human-browser-login-tool.ts`               | **New**     | Phase 5 T1  | Core agent tool: blocks run, hands off browser to human                   |
| `src/agents/tools/human-browser-login-tool.test.ts`          | **New**     | Phase 5 T1  | Unit tests (10 tests)                                                     |
| `src/gateway/server/browser-session-ws.ts`                   | **New**     | Phase 5 T2  | CDP WebSocket proxy (allowlisted methods only)                            |
| `src/gateway/server/browser-session-ws.test.ts`              | **New**     | Phase 5 T2  | Tests (10 tests)                                                          |
| `src/gateway/server/routes/browser-sessions.ts`              | **New**     | Phase 5 T3  | `POST /api/browser-sessions/:id/resume` endpoint                          |
| `src/gateway/server/routes/browser-sessions.test.ts`         | **New**     | Phase 5 T3  | Tests (5 tests)                                                           |
| `src/agents/openclaw-tools.ts`                               | Modified    | Phase 5 T1  | Register `request_human_browser_login` tool when env vars present         |
| `src/gateway/server/ws-connection/handshake-auth-helpers.ts` | Modified    | Phase 5     | Add `trustAuthenticatedBackend` param to `shouldSkipBackendSelfPairing()` |
| `src/gateway/server/ws-connection/message-handler.ts`        | Modified    | Phase 5     | Read `OPENCLAW_TRUST_BACKEND_AUTH` env var and pass to handshake helper   |
| `.github/workflows/57claws-sync-build.yml`                   | **New**     | Infra       | Automated upstream sync → Docker build → DO registry push                 |

---

## 3. New Files

### 3.1 Dockerfile additions

**File:** `Dockerfile`

Find the `apt-get install` line in the build stage and add `python3 python3-pip` to it. Then add a `RUN pip install` line immediately after:

```dockerfile
# Find this line (exact package list may vary across releases):
RUN apt-get install -y --no-install-recommends \
    procps hostname curl git openssl

# Change to (add python3 python3-pip):
RUN apt-get install -y --no-install-recommends \
    procps hostname curl git openssl python3 python3-pip

# Add this line immediately after the apt-get install block:
# 57-Claws: beautifulsoup4 + requests for web scraping tools used by agents
RUN pip install --no-cache-dir --break-system-packages beautifulsoup4==4.12.3 requests==2.32.3
```

Verification (run in CI via `57claws-sync-build.yml`):

- `grep -q 'python3 python3-pip' Dockerfile`
- `grep -q 'beautifulsoup4' Dockerfile`
- `grep -q 'requests' Dockerfile`

---

### 3.2 `src/agents/tools/human-browser-login-tool.ts` _(new file)_

Create this file verbatim. It is the T1 agent tool — blocks the run and registers the session in an in-process map until a human resumes it.

Key exports:

- `pendingSessionsMap` — module-level Map shared with T2 and T3
- `resolveSession(sessionId)` — called by T3 to unblock the waiting agent
- `rejectSession(sessionId, err)` — called on timeout
- `BrowserSessionTimeoutError` — error class for timeout
- `createHumanBrowserLoginTool(opts)` — factory returning an `AnyAgentTool`

Tool name registered with the model: `request_human_browser_login`

Integration:

- On execute: calls `POST {paperclipApiUrl}/api/internal/browser-session-request` with `x-openclaw-token` header
- Creates a Playwright `CDPSession` for the current page and stores it in `pendingSessionsMap`
- Awaits an internal Promise until `resolveSession` is called (by T3) or timeout fires
- Default timeout: 30 minutes

Deduplication: if `runId` already has an active session, piggybacks on the same promise without calling the webhook again.

---

### 3.3 `src/gateway/server/browser-session-ws.ts` _(new file)_

Create this file verbatim. It is the T2 CDP WebSocket proxy.

Key exports:

- `CDP_ALLOWED_FROM_CLIENT` — methods the Paperclip viewer may send:
  `["Page.startScreencast", "Page.screencastFrameAck", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText"]`
- `CDP_ALLOWED_FROM_CHROME` — events from Chrome forwarded to viewer:
  `["Page.screencastFrame", "Page.screencastStopped", "Page.frameNavigated", "Page.loadEventFired", "Page.domContentEventFired", "Page.javascriptDialogOpening"]`
- `attachBrowserSessionCdpWs({ server, wss, openclawGatewayToken })` — registers HTTP upgrade handler on the main `http.Server`

Route: `/api/browser-sessions/:id/cdp` (WebSocket upgrade)

Auth: `x-openclaw-token` header, SHA-256 timing-safe comparison against `openclawGatewayToken`.

Security:

- 401 on missing/wrong token
- 404 on unknown sessionId
- 4403 close code on disallowed CDP method (never forwarded)
- On client disconnect: `cdpSession.detach()` + remove all CDP event listeners

---

### 3.4 `src/gateway/server/routes/browser-sessions.ts` _(new file)_

Create this file verbatim. It is the T3 HTTP resume endpoint.

Route: `POST /api/browser-sessions/:id/resume`

Auth: `x-openclaw-token` header, SHA-256 timing-safe comparison.

Responses:

- `200 { ok: true }` — session resolved
- `401 { error: "unauthorized" }` — bad/missing token
- `404 { error: "not_found" }` — sessionId not in map
- `409 { error: "already_resolved" }` — race: already resolved
- `400 { error: "bad_request" }` — missing sessionId param

The endpoint imports `resolveSession` from `human-browser-login-tool.ts` and calls it, unblocking the waiting agent.

---

### 3.5 `.github/workflows/57claws-sync-build.yml` _(new file)_

This file is already present in the fork. If it disappears after an upstream merge, recreate it from the version in this repo. It automates:

1. Merge upstream tag → `main`
2. Verify Dockerfile patches (python3, beautifulsoup4, requests) + Phase 5 files
3. Build Docker image → push to DO registry (`registry.digitalocean.com/claws-cloud-registry/openclaw`)
4. Push updated `main` back to fork

Triggers: manual dispatch (`upstream_tag` input) or daily schedule (06:00 UTC).

Required secret: `DIGITALOCEAN_ACCESS_TOKEN`

---

## 4. Modified Files

### 4.1 `src/agents/openclaw-tools.ts`

**Where to apply:** In the tools array construction. Add the following BEFORE the `return tools;` or equivalent final export.

**Step 1 — Add import at the top of the file:**

```typescript
import { createHumanBrowserLoginTool } from "./tools/human-browser-login-tool.js";
```

**Step 2 — Add tool construction block (before building the final tools array):**

```typescript
// Human browser login tool: only available when Paperclip integration is configured.
// Env vars: OPENCLAW_PAPERCLIP_API_URL, OPENCLAW_GATEWAY_TOKEN
const paperclipApiUrl = process.env.OPENCLAW_PAPERCLIP_API_URL?.trim();
const openclawGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
const humanBrowserLoginTool =
  paperclipApiUrl && openclawGatewayToken
    ? createHumanBrowserLoginTool({
        paperclipApiUrl,
        openclawGatewayToken,
      })
    : null;
```

**Step 3 — Include in tools array (spread with guard):**

```typescript
...(humanBrowserLoginTool ? [humanBrowserLoginTool] : []),
```

---

### 4.2 `src/gateway/server/ws-connection/handshake-auth-helpers.ts`

**What to add:** The `shouldSkipBackendSelfPairing()` function needs an optional `trustAuthenticatedBackend` parameter that bypasses the loopback check for Docker bridge connections.

Find the `shouldSkipBackendSelfPairing` function. Update its parameter type to include:

```typescript
trustAuthenticatedBackend?: boolean;
```

Add this conditional block at the BEGINNING of the function body (before existing loopback check):

```typescript
// When OPENCLAW_TRUST_BACKEND_AUTH is set (e.g. Docker deployments where
// Paperclip connects over a bridge network), skip the loopback check for
// backend clients that already passed shared-secret authentication.
//
// SECURITY: this bypass must only be enabled on internal Docker/private
// networks. Never enable it when the gateway is reachable from the public
// internet. Always rotate OPENCLAW_GATEWAY_TOKEN regularly.
if (params.trustAuthenticatedBackend) {
  return !params.hasBrowserOriginHeader;
}
```

---

### 4.3 `src/gateway/server/ws-connection/message-handler.ts`

**What to add:** Read the env var and pass it to `shouldSkipBackendSelfPairing`.

Find the call site of `shouldSkipBackendSelfPairing(...)` in this file.

**Step 1 — Add env var read (near the top of the call site's function or module scope):**

```typescript
const trustAuthenticatedBackend = process.env.OPENCLAW_TRUST_BACKEND_AUTH === "true";
```

**Step 2 — Pass it into the function call:**

```typescript
shouldSkipBackendSelfPairing({
  // ... existing params unchanged ...
  trustAuthenticatedBackend,
});
```

---

## 5. Verification After Applying Changes

Run the following to confirm everything is in place:

```bash
# File existence
test -f src/agents/tools/human-browser-login-tool.ts && echo "T1 OK" || echo "T1 MISSING"
test -f src/gateway/server/browser-session-ws.ts && echo "T2 OK" || echo "T2 MISSING"
test -f src/gateway/server/routes/browser-sessions.ts && echo "T3 OK" || echo "T3 MISSING"

# Dockerfile patches
grep -q 'python3 python3-pip' Dockerfile && echo "Dockerfile python3 OK" || echo "Dockerfile python3 MISSING"
grep -q 'beautifulsoup4' Dockerfile && echo "Dockerfile bs4 OK" || echo "Dockerfile bs4 MISSING"

# Tool registration
grep -q 'OPENCLAW_PAPERCLIP_API_URL' src/agents/openclaw-tools.ts && echo "Tool registration OK" || echo "Tool registration MISSING"

# Backend auth env
grep -q 'OPENCLAW_TRUST_BACKEND_AUTH' src/gateway/server/ws-connection/message-handler.ts && echo "Backend auth OK" || echo "Backend auth MISSING"

# Tests pass
pnpm test
```

---

## 6. Notes for AI Agents

- New files (T1, T2, T3) are **self-contained** — they do not patch upstream code, only add new modules. If they disappear after a merge, re-create them from the PR #11 source.
- Modified files (openclaw-tools.ts, handshake-auth-helpers.ts, message-handler.ts) make **additive, non-breaking changes** — adding optional params and conditional code paths. Upstream changes to these files should not conflict.
- The Dockerfile patch may conflict if upstream changes the apt-get line significantly. The sync workflow auto-resolves Dockerfile conflicts by keeping our version (`--ours`). Verify the patch survived by running the verification checks above.
- Token auth throughout uses SHA-256 hex (always 64 bytes) + `crypto.timingSafeEqual` — safe because equal-length buffers are guaranteed.
