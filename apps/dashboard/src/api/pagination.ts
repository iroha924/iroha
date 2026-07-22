/**
 * Flattens infinite-query pages into a single de-duplicated list, keyed by `id`.
 * Keyset pages can overlap at the seam when rows mutate between fetches — a
 * candidate leaving the Review queue on approval, a Session's `last_seen_at`
 * bumping while it polls — which would otherwise surface the same row twice and
 * collide React keys. First occurrence wins, preserving the page (newest-first)
 * order and keeping the freshest copy from the earlier page.
 */
export function flattenPages<T extends { id: string }>(pages: ReadonlyArray<{ items: T[] }>): T[] {
  const byId = new Map<string, T>();
  for (const page of pages) {
    for (const item of page.items) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }
  }
  return Array.from(byId.values());
}
