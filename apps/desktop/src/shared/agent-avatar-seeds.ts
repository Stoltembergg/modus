import type { AgentAvatarFace } from "./contracts-parts/contracts-part-08";

/*
 * Avatar seeds. The avatar package (@tryopenbot/agent-avatar 0.2.0) derives
 * an avatar's eyes, halftone tone and busy ribbons from the `id` it is given;
 * it has no eyes prop. An agent is drawn with `avatarSeed ?? id`: agents
 * saved before avatar_seed (NULL) keep their id-seeded look, and the New
 * Agent face picker stores one of the eight seeds below so the dialog preview
 * is exactly the saved avatar.
 */

/** Allowed seed text: short and URL/ID safe. Empty or blank normalizes to null. */
export const AGENT_AVATAR_SEED_MAX = 64;
export const AGENT_AVATAR_SEED_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * One seed per face, chosen so the package's own hash (fnv1a + mix, salt
 * "eyes", over its 27 numerically sorted eye masks) picks eye set 0..7 in the
 * order of AGENT_AVATAR_FACES. Pinned by agent-avatar-seeds.test.ts against the
 * package's rendered output, so a package hash change fails the test.
 */
export const AGENT_FACE_SEEDS: Readonly<Record<AgentAvatarFace, string>> = {
  happy: "face-happy-9",
  curious: "face-curious-14",
  sleepy: "face-sleepy-2",
  wink: "face-wink-29",
  focused: "face-focused-18",
  cheeky: "face-cheeky-15",
  calm: "face-calm-40",
  bright: "face-bright-46",
};

/** The face a picker seed stands for (undefined for any other seed). */
export function faceForAvatarSeed(seed: string | null | undefined): AgentAvatarFace | undefined {
  if (!seed) return undefined;
  for (const [face, value] of Object.entries(AGENT_FACE_SEEDS)) {
    if (value === seed) return face as AgentAvatarFace;
  }
  return undefined;
}

/** Trimmed seed, or null when absent / blank. Never "". Throws on a bad charset or length. */
export function normalizeAvatarSeed(value: string | null | undefined): string | null {
  const seed = value?.trim() ?? "";
  if (!seed) return null;
  if (seed.length > AGENT_AVATAR_SEED_MAX || !AGENT_AVATAR_SEED_PATTERN.test(seed)) {
    throw new Error("Invalid avatar seed.");
  }
  return seed;
}

/** The seed an agent's avatar is drawn with: its stored seed, else its id. */
export function agentAvatarSeed(agent: {
  id: string;
  avatarSeed?: string | null | undefined;
}): string {
  return agent.avatarSeed || agent.id;
}
