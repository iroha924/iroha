/**
 * The per-process CSP nonce the dashboard server stamps into the page as
 * `<meta name="csp-nonce">` (packages/api `static.ts`). The UI library injects a
 * few runtime `<style>` elements — Base UI overlays' scroll-lock/scrollbar
 * styles and the Chart color bridge — and stamping this nonce on them satisfies
 * `style-src 'self' 'nonce-…'`. Returns `undefined` under `vite dev`/tests, where
 * no server injects the tag and the strict CSP is not applied either.
 */
export function cspNonce(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content") ?? undefined;
}
