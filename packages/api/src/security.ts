import type { MiddlewareHandler } from "hono";

/**
 * dashboard-api.md §9 security headers. The CSP is deliberately strict — only
 * same-origin scripts/styles/connections, `data:` images (for inline icons),
 * no `object`/`base`/`frame-ancestors`, no `unsafe-eval` — because the SPA is
 * fully self-hosted and never loads a CDN script or remote font.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
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
