import { timingSafeEqual } from "node:crypto";
import type { RandomSource } from "@iroha/core";

/** The HttpOnly session cookie name (dashboard-api.md §3). */
export const SESSION_COOKIE = "iroha_session";

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export interface Auth {
  /** The one-time launch token handed to the browser via URL fragment. */
  readonly launchToken: string;
  /** Exchanges the launch token for an opaque session-cookie value, or `null` on mismatch/replay. */
  exchange(providedToken: string): string | null;
  verify(cookieValue: string | undefined): boolean;
  revoke(cookieValue: string | undefined): void;
}

/**
 * The dashboard's cookie-session authority (dashboard-api.md §3). A 256-bit
 * launch token is exchanged exactly once for a random opaque session cookie
 * bound to this process; the exchange is single-use so a replay of the launch
 * token (dashboard-api.md §10 "auth exchange and replay rejection") is refused.
 * All state is in-memory and dies with the process — the cookie is never
 * persisted and is rotated on each dashboard start.
 */
export function createAuth(random: RandomSource, launchToken?: string): Auth {
  const token = launchToken ?? base64url(random.bytes(32));
  let consumed = false;
  const sessions = new Set<string>();
  return {
    launchToken: token,
    exchange(providedToken) {
      if (consumed || !constantTimeEquals(providedToken, token)) {
        return null;
      }
      consumed = true;
      const cookieValue = base64url(random.bytes(32));
      sessions.add(cookieValue);
      return cookieValue;
    },
    verify(cookieValue) {
      return cookieValue !== undefined && sessions.has(cookieValue);
    },
    revoke(cookieValue) {
      if (cookieValue !== undefined) {
        sessions.delete(cookieValue);
      }
    },
  };
}
