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

/** Eye sets in the avatar package (0.2.0): `Object.keys(avatarEyeMasks).length`. */
export const AVATAR_EYE_SET_COUNT = 27;

/**
 * The eye set index the avatar package draws for a seed: a copy of its
 * `pick(seed, "eyes", n)` (fnv1a, then a mix). Pinned against the package's
 * rendered output by agent-avatar-seeds.test.ts.
 */
export function avatarEyeIndex(seed: string): number {
  let hash = 2166136261;
  for (const char of `${seed}/eyes`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  let h = hash >>> 0;
  h = Math.imul(h ^ (h >>> 16), 73244475);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) % AVATAR_EYE_SET_COUNT;
}

/**
 * A copy's starting face seed: one of the eight, picked at random, never the
 * one that draws the same eyes as the source (its stored face seed, or the
 * eyes its id gives it when that is one of the eight sets).
 */
export function copyAvatarSeed(
  source: { id: string; avatarSeed?: string | null | undefined },
  random: () => number = Math.random,
): string {
  const sourceEyes = avatarEyeIndex(agentAvatarSeed(source));
  const all = Object.values(AGENT_FACE_SEEDS);
  const options = all.filter((seed) => avatarEyeIndex(seed) !== sourceEyes);
  const pool = options.length > 0 ? options : all;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index] as string;
}

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
