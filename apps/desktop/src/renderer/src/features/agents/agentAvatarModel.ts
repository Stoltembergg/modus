import { agentAvatarForId } from "../../../../shared/agent-templates";
import type {
  AgentAvatarColor,
  AgentAvatarFace,
  AgentAvatarShape,
  AgentGroupMember,
} from "../../../../shared/contracts";
import type { GroupActivityState } from "../groups/useWorkingGroups";

/** What the avatar shows: idle (blink + float), working, waiting for you, archived (grey). */
export type AgentAvatarState = "idle" | "working" | "waiting" | "archived";

/** The app sizes: small metadata, message / chip, compact header and dialog preview. */
export type AgentAvatarSize = 16 | 20 | 24 | 48;

/**
 * Fill per palette token. Paired with {@link AGENT_AVATAR_INK} for contrast on
 * both themes; archived agents use {@link AGENT_AVATAR_ARCHIVED_FILL}.
 */
export const AGENT_AVATAR_FILL: Record<AgentAvatarColor, string> = {
  red: "#f87171",
  orange: "#fb923c",
  amber: "#fbbf24",
  lime: "#a3e635",
  green: "#4ade80",
  teal: "#2dd4bf",
  sky: "#38bdf8",
  blue: "#60a5fa",
  violet: "#a78bfa",
  pink: "#f472b6",
  rose: "#fb7185",
  fuchsia: "#e879f9",
  indigo: "#818cf8",
  cyan: "#22d3ee",
  emerald: "#34d399",
  yellow: "#facc15",
  stone: "#a8a29e",
  slate: "#475569",
  coral: "#ff7f6a",
  mint: "#6ee7b7",
  grape: "#7c3aed",
  navy: "#1e3a5f",
};

/** Face/line ink paired with each fill (dark on light fills, light on deep fills). */
export const AGENT_AVATAR_INK: Record<AgentAvatarColor, string> = {
  red: "#18181b",
  orange: "#18181b",
  amber: "#18181b",
  lime: "#18181b",
  green: "#18181b",
  teal: "#18181b",
  sky: "#18181b",
  blue: "#18181b",
  violet: "#18181b",
  pink: "#18181b",
  rose: "#18181b",
  fuchsia: "#18181b",
  indigo: "#18181b",
  cyan: "#18181b",
  emerald: "#18181b",
  yellow: "#18181b",
  stone: "#18181b",
  slate: "#f4f4f5",
  coral: "#18181b",
  mint: "#18181b",
  grape: "#faf5ff",
  navy: "#eef2ff",
};

/** Archived agents are drawn in this grey (and never animate). */
export const AGENT_AVATAR_ARCHIVED_FILL = "#71717a";
export const AGENT_AVATAR_ARCHIVED_INK = "#e4e4e7";

/** A member's avatar: stored face / color / shape, or the id-derived default. */
export function memberAvatar(
  member: Pick<AgentGroupMember, "agentId" | "avatarFace" | "avatarColor" | "avatarShape">,
): {
  face: AgentAvatarFace;
  color: AgentAvatarColor;
  shape: AgentAvatarShape;
} {
  const fallback = agentAvatarForId(member.agentId);
  return {
    face: member.avatarFace ?? fallback.avatarFace,
    color: member.avatarColor ?? fallback.avatarColor,
    shape: member.avatarShape ?? fallback.avatarShape,
  };
}

/** The avatar state of a member: archived wins, then the room activity (waiting > working). */
export function agentAvatarState(
  activity: GroupActivityState | undefined,
  archived: boolean,
): AgentAvatarState {
  if (archived) return "archived";
  if (activity === "queued") return "idle";
  return activity ?? "idle";
}

function hash(seed: string): number {
  let value = 0;
  for (const char of seed) value = (value * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return value;
}

/**
 * Per-agent timing so a row of avatars does not blink in unison: a negative
 * start offset (0..-3.9 s) and a blink period of 3.6..4.4 s.
 */
export function agentAvatarTiming(seed: string): { delay: string; blink: string } {
  const value = hash(seed);
  const delay = (value % 40) / 10;
  const blink = 3.6 + ((value >>> 8) % 9) / 10;
  return { delay: `-${delay.toFixed(1)}s`, blink: `${blink.toFixed(1)}s` };
}
