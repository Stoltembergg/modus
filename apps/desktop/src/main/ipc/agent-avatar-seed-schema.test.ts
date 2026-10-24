import { describe, expect, it } from "vitest";
import { AGENT_FACE_SEEDS } from "../../shared/agent-avatar-seeds";
import * as live from "./schemas";
import * as part04 from "./schemas-part-04";
import * as shared from "./schemas-shared";

/* avatarSeed on the strict agent IPC schemas (PR #278): live schemas and both copies. */

const BAD = ["has space", "emoji-🙂", "slash/seed", "dot.seed", "x".repeat(65), 7, true];
const VALID = [AGENT_FACE_SEEDS.wink, "abc_DEF-123", "x".repeat(64)];

const variants = {
  "live agents:create": (avatarSeed: unknown) =>
    live.agentsCreateSchema.safeParse({ name: "Ana", avatarSeed }),
  "live agents:update": (avatarSeed: unknown) =>
    live.agentsUpdateSchema.safeParse({ id: "a-1", avatarSeed }),
  "part-04 agents:create": (avatarSeed: unknown) =>
    part04.agentsCreateSchema.safeParse({ name: "Ana", avatarSeed }),
  "part-04 agents:update": (avatarSeed: unknown) =>
    part04.agentsUpdateSchema.safeParse({ id: "a-1", avatarSeed }),
  "shared new group agent": (avatarSeed: unknown) =>
    shared.newGroupAgentSchema.safeParse({ name: "Ana", avatarSeed }),
};

describe.each(Object.entries(variants))("%s avatarSeed", (_name, parse) => {
  const seedOf = (result: ReturnType<typeof parse>) => {
    if (!result.success) throw new Error(result.error.message);
    const data = result.data as { avatarSeed?: unknown; members?: Array<{ avatarSeed?: unknown }> };
    return data.members ? data.members[0]?.avatarSeed : data.avatarSeed;
  };

  it("accepts URL-safe seeds up to 64 characters (trimmed)", () => {
    for (const seed of VALID) expect(seedOf(parse(seed))).toBe(seed);
    expect(seedOf(parse(`  ${AGENT_FACE_SEEDS.calm}  `))).toBe(AGENT_FACE_SEEDS.calm);
  });

  it("parses empty / whitespace / null as null, never ''", () => {
    for (const blank of ["", "   ", "\t\n", null]) expect(seedOf(parse(blank))).toBeNull();
  });

  it("is optional", () => {
    expect(seedOf(parse(undefined))).toBeUndefined();
  });

  it("rejects bad characters, over 64 characters and non-strings", () => {
    for (const bad of BAD) expect(parse(bad).success).toBe(false);
  });
});

it("the schemas stay strict apart from avatarSeed (no client id)", () => {
  expect(live.agentsCreateSchema.safeParse({ name: "Ana", id: "client-id" }).success).toBe(false);
  expect(part04.agentsCreateSchema.safeParse({ name: "Ana", id: "client-id" }).success).toBe(false);
  expect(shared.newGroupAgentSchema.safeParse({ name: "Ana", id: "client-id" }).success).toBe(
    false,
  );
});
