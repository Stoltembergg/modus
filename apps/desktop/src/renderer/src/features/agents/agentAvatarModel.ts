import { agentAvatarForId } from "../../../../shared/agent-templates";
import type {
  AgentAvatarColor,
  AgentAvatarFace,
  AgentGroupMember,
} from "../../../../shared/contracts";
import type { GroupActivityState } from "../groups/useWorkingGroups";

/** What the avatar shows: idle (blink + float), working, waiting for you, archived (grey). */
export type AgentAvatarState = "idle" | "working" | "waiting" | "archived";

/** The three sizes the app uses: sidebar rows, room chips / authors, dialog preview. */
export type AgentAvatarSize = 16 | 20 | 48;

/** Fill per palette name (Tailwind's 400 shades as literals: legible on both themes). */
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
};

/** Archived agents are drawn in this grey (and never animate). */
export const AGENT_AVATAR_ARCHIVED_FILL = "#71717a";

/** A member's avatar: its stored face / color, or the id-derived default. */
export function memberAvatar(
  member: Pick<AgentGroupMember, "agentId" | "avatarFace" | "avatarColor">,
): {
  face: AgentAvatarFace;
  color: AgentAvatarColor;
} {
  const fallback = agentAvatarForId(member.agentId);
  return {
    face: member.avatarFace ?? fallback.avatarFace,
    color: member.avatarColor ?? fallback.avatarColor,
  };
}

/** The avatar state of a member: archived wins, then the room activity (waiting > working). */
export function agentAvatarState(
  activity: GroupActivityState | undefined,
  archived: boolean,
): AgentAvatarState {
  if (archived) return "archived";
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
