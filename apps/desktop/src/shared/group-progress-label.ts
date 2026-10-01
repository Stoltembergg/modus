/**
 * Concrete group progress labels: queued with age, waiting on model,
 * running tests — not a generic "Working".
 */

import {
  type GroupRoomLocale,
  groupRoomLabel,
  groupWaitingForAgentLabel,
  resolveGroupRoomLocale,
  thinkingStateKeyFromLive,
} from "./group-room-locale";
import { formatElapsed } from "./managed-process";

export type GroupProgressLabelInput = {
  phase: string;
  presenceState?: string | undefined;
  activity?: string | undefined;
  waitingFor?: string | undefined;
  stillWorking?: boolean | undefined;
  /** Epoch ms when this phase / queue wait started (for queued age). */
  startedAt?: number | undefined;
  nowMs?: number | undefined;
  locale?: string | null | undefined;
};

function joinNames(names: readonly string[], locale: GroupRoomLocale): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  if (locale === "zh") return names.join("、");
  if (locale === "pt") return `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Living progress label for a member turn.
 * Queued rows append age (`Queued · 12s`); thinking maps to Waiting on model.
 */
export function formatGroupProgressLabel(input: GroupProgressLabelInput): string {
  const waitingFor = input.waitingFor?.trim();
  if (
    !input.stillWorking &&
    (input.presenceState === "waiting_for_agent" || /^waiting$/i.test(input.phase)) &&
    waitingFor
  ) {
    return groupWaitingForAgentLabel(waitingFor, input.locale);
  }

  const key = thinkingStateKeyFromLive({
    phase: input.phase,
    presenceState: input.presenceState,
    activity: input.activity,
    stillWorking: input.stillWorking,
  });
  let label = groupRoomLabel(key, input.locale);

  const isQueued =
    key === "queued" || input.presenceState === "queued" || /^queued$/i.test(input.phase.trim());
  if (isQueued && input.startedAt != null && Number.isFinite(input.startedAt)) {
    const now = input.nowMs ?? Date.now();
    const age = formatElapsed(Math.max(0, now - input.startedAt));
    const stripped = label
      .replace(/…$/u, "")
      .replace(/\.\.\.$/u, "")
      .trimEnd();
    label = `${stripped} · ${age}`;
  }
  return label;
}

/**
 * Composer shimmer copy naming the agent(s) plus their concrete phase
 * (`Builder · Waiting on model…`) instead of opaque "is working…".
 */
export function groupAgentProgressShimmerLabel(input: {
  names: readonly string[];
  phaseLabel: string;
  locale?: string | null;
}): string {
  const catalog = resolveGroupRoomLocale(input.locale);
  const cleaned = input.names.map((name) => name.replace(/^@/, "").trim()).filter(Boolean);
  const phase = input.phaseLabel.trim() || groupRoomLabel("waitingOnModel", input.locale);
  if (cleaned.length === 0) return phase;
  return `${joinNames(cleaned, catalog)} · ${phase}`;
}
