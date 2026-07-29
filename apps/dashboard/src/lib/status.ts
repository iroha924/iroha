// Maps domain status strings to the brand Badge tones (see badge.tsx variants).
// Shared so the run / candidate / knowledge lists stay visually consistent.

export type StatusTone =
  | "approve"
  | "pending"
  | "reject"
  | "neutral"
  | "ai"
  | "suou"
  | "tokusa"
  | "fuji"
  | "asagi"
  | "kurikawa"
  | "nibi";

/** Knowledge entity status → tone. */
export function knowledgeStatusTone(status: string): StatusTone {
  if (status === "approved") return "approve";
  if (status === "archived") return "reject";
  return "neutral";
}

/**
 * The seven canonical knowledge types, each with one tone and the matching CSS
 * colour. Both the Review/Knowledge badges and the Overview composition chart
 * read from here, so a type cannot end up two colours in two views — which is
 * exactly what happened while the chart kept its own `--chart-*` series.
 *
 * Order is the canonical type order and is stable: the chart's bars are read
 * against it. None of these are matcha, persimmon or amber — those carry
 * approve / reject / pending, and a type badge must not look like a verdict.
 */
export const KNOWLEDGE_TYPES = [
  { key: "decision", tone: "ai", color: "var(--color-ai)" },
  { key: "rule", tone: "tokusa", color: "var(--color-tokusa)" },
  { key: "concept", tone: "kurikawa", color: "var(--color-kurikawa)" },
  { key: "insight", tone: "fuji", color: "var(--color-fuji)" },
  { key: "incident", tone: "suou", color: "var(--color-suou)" },
  { key: "pattern", tone: "asagi", color: "var(--color-asagi)" },
  { key: "review_learning", tone: "nibi", color: "var(--color-nibi)" },
] as const satisfies ReadonlyArray<{ key: string; tone: StatusTone; color: string }>;

/**
 * Knowledge type → badge tone, keyed on the type alone. A given type is the same
 * colour on every page and in every state; status has its own badge and its own
 * tones. `session_summary` falls to neutral because nothing produces one today.
 */
export function knowledgeTypeTone(type: string): StatusTone {
  return KNOWLEDGE_TYPES.find((t) => t.key === type)?.tone ?? "neutral";
}
