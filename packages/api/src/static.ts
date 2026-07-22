import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { MiddlewareHandler } from "hono";
import { cspNonce } from "./security.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const NONCE_META = `<meta name="csp-nonce" content="${cspNonce}">`;

/**
 * Builds the SPA response, stamping the per-process CSP nonce into the served
 * HTML so the client can read it (`<meta name="csp-nonce">`) and apply it to the
 * UI library's runtime `<style>` elements. `cspNonce` is base64url, so it is
 * safe to embed verbatim in the attribute. Non-HTML assets pass through
 * untouched.
 */
function spaResponse(file: { body: Uint8Array; type: string }): Response {
  const headers = { "Content-Type": file.type };
  if (!file.type.startsWith("text/html")) {
    return new Response(file.body, { status: 200, headers });
  }
  const html = new TextDecoder().decode(file.body).replace("</head>", `  ${NONCE_META}\n</head>`);
  return new Response(html, { status: 200, headers });
}

/**
 * Reads a file under `root` for a request path, or `null` if it escapes `root`
 * or is missing. Traversal is rejected on the raw path BEFORE any filesystem
 * access (OWASP: reject `..` up front rather than sanitize after), then the
 * resolved real path is confirmed inside the resolved real `root` so a symlink
 * inside the served directory cannot point outside it.
 */
async function readWithin(
  root: string,
  urlPath: string,
): Promise<{ body: Uint8Array; type: string } | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.split("/").includes("..")) {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const candidate = join(root, relative);
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpath(root);
    realCandidate = await realpath(candidate);
  } catch {
    return null;
  }
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    return null;
  }
  try {
    const body = await readFile(realCandidate);
    return { body, type: contentType(realCandidate) };
  } catch {
    return null;
  }
}

/**
 * Serves the built SPA from `root` for non-API GET requests, falling back to
 * index.html for client-side routes so a direct-route reload works
 * (dashboard-api.md §10). API paths are left to return the JSON 404.
 */
export function createStaticHandler(root: string): MiddlewareHandler {
  return async (c) => {
    if (c.req.method !== "GET" || c.req.path.startsWith("/api/")) {
      return c.notFound();
    }
    const file = await readWithin(root, c.req.path);
    if (file !== null) {
      return spaResponse(file);
    }
    const index = await readWithin(root, "/index.html");
    if (index !== null) {
      return spaResponse(index);
    }
    return c.notFound();
  };
}
