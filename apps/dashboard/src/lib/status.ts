// Maps domain status strings to the brand Badge tones (see badge.tsx variants).
// Shared so the run / candidate / knowledge lists stay visually consistent.

export type StatusTone = "approve" | "pending" | "reject" | "neutral";

/** Run/session lifecycle status → tone. */
export function runStatusTone(status: string | null): StatusTone {
  if (status === "active") return "approve";
  if (status === "interrupted") return "pending";
  if (status === "abandoned") return "reject";
  return "neutral";
}

/** Candidate review status → tone. */
export function candidateStatusTone(status: string): StatusTone {
  if (status === "approved") return "approve";
  if (status === "pending") return "pending";
  if (status === "rejected") return "reject";
  return "neutral";
}

/** Approved-knowledge status → tone. */
export function knowledgeStatusTone(status: string): StatusTone {
  if (status === "approved") return "approve";
  if (status === "archived") return "reject";
  return "neutral";
}

/** Checkpoint outcome → tone. */
export function checkpointOutcomeTone(outcome: string): StatusTone {
  if (outcome === "completed") return "approve";
  if (outcome === "blocked") return "reject";
  if (outcome === "partial") return "pending";
  return "neutral";
}

/** Checkpoint validation result → tone. */
export function validationResultTone(result: string): StatusTone {
  if (result === "passed") return "approve";
  if (result === "failed") return "reject";
  return "neutral";
}
