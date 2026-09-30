/**
 * P2 kickoff helpers — guided first message for a new group room
 * (outcome + first owner), matching the Grok-style collab kickoff.
 */

export type GroupKickoffDraft = {
  outcome: string;
  /** Member title without leading @. */
  firstOwner: string;
  /** Optional short pipeline hint (e.g. "Builder implements · Reviewer blocks only"). */
  nextSteps?: string;
  /** What still needs the human (merge / publish / deploy). */
  approval?: string;
};

/** Canonical kickoff body inserted into the room composer. */
export function formatGroupKickoffDraft(draft: GroupKickoffDraft): string {
  const outcome = draft.outcome.trim() || "…";
  const owner = draft.firstOwner.trim().replace(/^@/, "");
  const lines = [`Outcome: ${outcome}`, `First owner: @${owner || "…"}`];
  const next = draft.nextSteps?.trim();
  if (next) lines.push(`Next: ${next}`);
  const approval = draft.approval?.trim();
  if (approval) lines.push(`Approval: ${approval}`);
  return lines.join("\n");
}

/** Default "Next" line for the Planner → Builder → Reviewer pipeline. */
export const COLLAB_PIPELINE_NEXT = "@Builder implements · @Reviewer blocking gaps only";

/** Default human gate when none is specified. */
export const COLLAB_PIPELINE_APPROVAL = "merge / publish — wait for me";

/** Template ids that form the default collab pipeline (order matters; Planner leads). */
export const COLLAB_PIPELINE_TEMPLATE_IDS = ["planner", "builder", "reviewer"] as const;
