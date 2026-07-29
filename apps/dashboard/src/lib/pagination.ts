/**
 * Numbered-page helpers shared by the Review queue and the Knowledge list.
 *
 * Extracted rather than copied: `pageWindow`'s gap handling is the kind of thing
 * that gets fixed in one copy and not the other, and the two pages would then
 * disagree about which numbers they show.
 */

/** Numbered buttons to render, with `null` standing in for an ellipsis. */
export function pageWindow(current: number, count: number): Array<number | null> {
  if (count <= 7) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  const window = new Set([1, count, current, current - 1, current + 1]);
  const pages = Array.from(window)
    .filter((n) => n >= 1 && n <= count)
    .sort((a, b) => a - b);
  const withGaps: Array<number | null> = [];
  for (const [i, page] of pages.entries()) {
    const previous = pages[i - 1];
    if (previous !== undefined && page - previous > 1) {
      withGaps.push(null);
    }
    withGaps.push(page);
  }
  return withGaps;
}

/** A page number from the URL: whole, at least 1, and never NaN. */
export function parsePage(raw: string | null): number {
  const n = Number(raw ?? "1");
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
