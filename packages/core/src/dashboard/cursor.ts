/**
 * An opaque keyset pagination cursor: the `(sort-key, id)` of the last item on a
 * page, base64url-encoded. dashboard-api.md §4 requires cursor pagination with a
 * deterministic ID tie-breaker, so both halves are encoded — the cursor stays
 * stable even when many rows share a sort key (e.g. one Checkpoint emitting
 * several candidates at the same timestamp).
 */
export interface CursorParts {
  key: string;
  id: string;
}

export function encodeCursor(parts: CursorParts): string {
  return Buffer.from(JSON.stringify([parts.key, parts.id]), "utf8").toString("base64url");
}

/** Returns `null` for a malformed cursor; the caller surfaces `INVALID_INPUT`. */
export function decodeCursor(cursor: string): CursorParts | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { key: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

/** Default page size and hard cap (dashboard-api.md §4: "default 30, maximum 100"). */
export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

/** Clamps a requested page size into `[1, MAX_PAGE_SIZE]`, defaulting when unset. */
export function resolvePageSize(requested: number | undefined): number {
  if (requested === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(requested)));
}
