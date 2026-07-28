// Maps domain status strings to the brand Badge tones (see badge.tsx variants).
// Shared so the run / candidate / knowledge lists stay visually consistent.

export type StatusTone =
  | "approve"
  | "pending"
  | "reject"
  | "neutral"
  | "matcha"
  | "persimmon"
  | "clay"
  | "iris"
  | "amber"
  | "ai"
  | "taikou";

/** Approved-knowledge status → tone. */
export function knowledgeStatusTone(status: string): StatusTone {
  if (status === "approved") return "approve";
  if (status === "archived") return "reject";
  return "neutral";
}

/**
 * Knowledge type → badge tone. The same brand family, in the same order, as the
 * Overview composition chart's series, so a type reads as one colour across the
 * dashboard. Every canonical type gets its own tone; `session_summary` falls to
 * neutral because nothing produces one today.
 */
export function knowledgeTypeTone(type: string): StatusTone {
  switch (type) {
    case "decision":
      return "matcha";
    case "review_learning":
      return "taikou";
    case "pattern":
      return "ai";
    case "rule":
      return "persimmon";
    case "concept":
      return "clay";
    case "insight":
      return "iris";
    case "incident":
      return "amber";
    default:
      return "neutral";
  }
}
