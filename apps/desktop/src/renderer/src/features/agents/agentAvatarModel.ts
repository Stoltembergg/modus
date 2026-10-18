import type { AgentAvatarShapeName } from "@tryopenbot/agent-avatar";
import { agentAvatarSeed } from "../../../../shared/agent-avatar-seeds";
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

/** The app sizes: small metadata, message / chip, compact header, preview tiles and the dialog preview. */
export type AgentAvatarSize = 16 | 20 | 24 | 48 | 64;

/** Every persisted silhouette is translated to an explicit package shape. */
export const AGENT_AVATAR_SHAPE_MAP: Record<AgentAvatarShape, AgentAvatarShapeName> = {
  circle: "pebble",
  squircle: "squircle",
  roundedSquare: "pebble",
  hexagon: "hex",
  triangle: "wedge",
  pentagon: "cloud",
  capsule: "tablet",
  blob: "blob",
  diamond: "teardrop",
  shield: "wedge",
};

export function agentAvatarPresentation(
  color: AgentAvatarColor,
  shape: AgentAvatarShape,
  state: AgentAvatarState,
  animated: boolean,
): {
  fill: string;
  shape: AgentAvatarShapeName;
  state: "idle" | "working" | "waiting";
  paused: boolean;
} {
  const archived = state === "archived";
  return {
    fill: archived ? AGENT_AVATAR_ARCHIVED_FILL : AGENT_AVATAR_FILL[color],
    shape: AGENT_AVATAR_SHAPE_MAP[shape],
    state: archived ? "idle" : state,
    paused: archived || !animated,
  };
}

/**
 * Fill per palette token; archived agents use {@link AGENT_AVATAR_ARCHIVED_FILL}.
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

/** Archived agents are drawn in this grey (and never animate). */
export const AGENT_AVATAR_ARCHIVED_FILL = "#71717a";

/**
 * A member's avatar: stored face / color / shape, or the id-derived default,
 * and the package seed it is drawn with (`avatarSeed ?? agentId`).
 */
export function memberAvatar(
  member: Pick<
    AgentGroupMember,
    "agentId" | "avatarFace" | "avatarColor" | "avatarShape" | "avatarSeed"
  >,
): {
  face: AgentAvatarFace;
  color: AgentAvatarColor;
  shape: AgentAvatarShape;
  seed: string;
} {
  const fallback = agentAvatarForId(member.agentId);
  return {
    seed: agentAvatarSeed({ id: member.agentId, avatarSeed: member.avatarSeed }),
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
