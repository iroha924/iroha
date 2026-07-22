import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * A per-process nonce for the handful of inline `<style>` elements the UI
 * library injects at runtime — Base UI overlays' scroll-lock/scrollbar styles
 * and the Chart component's color bridge. It is regenerated on each
 * `iroha dashboard` start (the same per-process lifetime as the launch token
 * and session cookie) and exposed to the SPA through a `<meta name="csp-nonce">`
 * tag (see static.ts) so the client can stamp it on those elements. Runtime
 * CSSOM positioning (Floating UI) needs no nonce and stays under
 * `style-src 'self'`; only injected `<style>` ELEMENTS (style-src-elem) do.
 */
export const cspNonce = randomBytes(16).toString("base64url");

/**
 * dashboard-api.md §9 security headers. The CSP is deliberately strict — only
 * same-origin scripts/styles/connections, `data:` images (for inline icons),
 * no `object`/`base`/`frame-ancestors`, no `unsafe-eval` — because the SPA is
 * fully self-hosted and never loads a CDN script or remote font. The single
 * relaxation is the per-process `'nonce-…'` on `style-src` above; `'unsafe-inline'`
 * is never used, so a would-be injected style without the nonce stays blocked.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  `style-src 'self' 'nonce-${cspNonce}'`,
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
  };
}
