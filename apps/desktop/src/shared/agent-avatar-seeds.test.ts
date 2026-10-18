import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentAvatar } from "@tryopenbot/agent-avatar";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AGENT_AVATAR_SEED_MAX,
  AGENT_FACE_SEEDS,
  AVATAR_EYE_SET_COUNT,
  agentAvatarSeed,
  avatarEyeIndex,
  copyAvatarSeed,
  faceForAvatarSeed,
  normalizeAvatarSeed,
} from "./agent-avatar-seeds";
import { AGENT_AVATAR_FACES } from "./contracts";

/*
 * The eight face seeds must make the avatar package draw eight DIFFERENT eye
 * sets (0..7, in face order). Checked against the package's own rendered
 * markup and its own eye masks, so a package hash or asset change fails here.
 */

/** The package's asset module (not in its "exports"): found next to its entry. */
async function packageEyeMasks(): Promise<{ masks: Record<string, string>; keys: string[] }> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = join(dir, "node_modules/@tryopenbot/agent-avatar/dist/agent-avatar-assets.js");
    if (existsSync(file)) {
      const assets = (await import(pathToFileURL(file).href)) as {
        avatarEyeMasks: Record<string, string>;
      };
      // Same ordering as the package: numeric keys, ascending.
      const keys = Object.keys(assets.avatarEyeMasks).sort((a, b) => Number(a) - Number(b));
      return { masks: assets.avatarEyeMasks, keys };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("@tryopenbot/agent-avatar is not installed");
    dir = parent;
  }
}

function renderedMask(seed: string): string {
  const markup = renderToStaticMarkup(createElement(AgentAvatar, { id: seed }));
  const match = /href="data:image\/png;base64,([^"]+)"/.exec(markup);
  if (!match?.[1]) throw new Error(`no eye mask rendered for ${seed}`);
  return match[1];
}

describe("AGENT_FACE_SEEDS", () => {
  it("has one seed per face, all valid seeds", () => {
    expect(Object.keys(AGENT_FACE_SEEDS)).toEqual([...AGENT_AVATAR_FACES]);
    for (const seed of Object.values(AGENT_FACE_SEEDS)) {
      expect(normalizeAvatarSeed(seed)).toBe(seed);
    }
    expect(new Set(Object.values(AGENT_FACE_SEEDS)).size).toBe(8);
  });

  it("render eight distinct eye sets, eye set i for face i (package hash and assets)", async () => {
    const { masks, keys } = await packageEyeMasks();
    expect(keys.length).toBeGreaterThanOrEqual(8);
    const rendered = AGENT_AVATAR_FACES.map((face) => renderedMask(AGENT_FACE_SEEDS[face]));
    expect(new Set(rendered).size).toBe(8);
    AGENT_AVATAR_FACES.forEach((face, index) => {
      const key = keys[index];
      if (key === undefined) throw new Error("missing eye key");
      expect(rendered[index], `${face} draws eye set ${index}`).toBe(masks[key]);
    });
  });

  it("maps each seed back to its face (anything else: no face)", () => {
    for (const face of AGENT_AVATAR_FACES) {
      expect(faceForAvatarSeed(AGENT_FACE_SEEDS[face])).toBe(face);
    }
    expect(faceForAvatarSeed("face-wink-30")).toBeUndefined();
    expect(faceForAvatarSeed(null)).toBeUndefined();
    expect(faceForAvatarSeed("")).toBeUndefined();
  });
});

describe("avatarEyeIndex / copyAvatarSeed", () => {
  it("avatarEyeIndex matches the eye set the package renders", async () => {
    const { masks, keys } = await packageEyeMasks();
    expect(keys).toHaveLength(AVATAR_EYE_SET_COUNT);
    for (const seed of [
      "a-1",
      "judas",
      "8c0e7c4e-5d0a-4b8e-9d55-6f1d2b7a0c11",
      "x",
      "face-wink-29",
    ]) {
      const key = keys[avatarEyeIndex(seed)];
      expect(key && masks[key], seed).toBe(renderedMask(seed));
    }
    AGENT_AVATAR_FACES.forEach((face, index) => {
      expect(avatarEyeIndex(AGENT_FACE_SEEDS[face])).toBe(index);
    });
  });

  it("picks one of the 8 seeds, never the source's eyes (stored seed or id-derived)", () => {
    const all = Object.values(AGENT_FACE_SEEDS);
    for (const face of AGENT_AVATAR_FACES) {
      const avatarSeed = AGENT_FACE_SEEDS[face];
      for (let step = 0; step < 16; step += 1) {
        const seed = copyAvatarSeed({ id: "src", avatarSeed }, () => step / 16);
        expect(all).toContain(seed);
        expect(seed).not.toBe(avatarSeed);
      }
    }
    // random → 1 (out of range) stays in range.
    expect(all).toContain(copyAvatarSeed({ id: "src", avatarSeed: null }, () => 0.999999));
    // A legacy source whose id draws one of the 8 eye sets: that face seed is excluded.
    let id = "legacy-0";
    for (let n = 0; avatarEyeIndex(id) >= 8; n += 1) id = `legacy-${n}`;
    for (let step = 0; step < 16; step += 1) {
      expect(copyAvatarSeed({ id }, () => step / 16)).not.toBe(all[avatarEyeIndex(id)]);
    }
  });
});

describe("normalizeAvatarSeed / agentAvatarSeed", () => {
  it("trims, turns blank into null (never ''), rejects bad text", () => {
    expect(normalizeAvatarSeed("  ab_C-1  ")).toBe("ab_C-1");
    for (const blank of [undefined, null, "", "   ", "\n\t"]) {
      expect(normalizeAvatarSeed(blank)).toBeNull();
    }
    for (const bad of ["a b", "a.b", "a/b", "ü", "x".repeat(AGENT_AVATAR_SEED_MAX + 1)]) {
      expect(() => normalizeAvatarSeed(bad)).toThrow(/Invalid avatar seed/);
    }
    expect(normalizeAvatarSeed("x".repeat(AGENT_AVATAR_SEED_MAX))).toHaveLength(64);
  });

  it("draws with the stored seed, else the id", () => {
    expect(agentAvatarSeed({ id: "a-1", avatarSeed: "face-calm-40" })).toBe("face-calm-40");
    expect(agentAvatarSeed({ id: "a-1", avatarSeed: null })).toBe("a-1");
    expect(agentAvatarSeed({ id: "a-1" })).toBe("a-1");
    expect(agentAvatarSeed({ id: "a-1", avatarSeed: "" })).toBe("a-1");
  });
});
