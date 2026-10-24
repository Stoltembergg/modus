import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { memberAvatar } from "./agentAvatarModel";

/*
 * Every agent avatar is drawn with `avatarSeed ?? id` (PR #278): the sidebar
 * (chat rows), the timeline and the dialog preview.
 */

const RENDERER_SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The only `seed=` expressions allowed on <AgentAvatar>. Agents go through
 * agentAvatarSeed / memberAvatar(...).seed;
 * the dialog through its preview seed and the 8 face seeds. Template cards are
 * not agents (no stored seed) and keep their template id.
 */
const ALLOWED_SEEDS = [
  /^agentAvatarSeed\(/,
  /^avatar\.seed$/,
  /^previewSeed$/,
  /^AGENT_FACE_SEEDS\[option\]$/,
  /^template\.id$/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

/** `seed={...}` props of each <AgentAvatar ...> element in a file (balanced braces). */
function avatarSeeds(source: string): string[] {
  const seeds: string[] = [];
  for (const match of source.matchAll(/<AgentAvatar\b/g)) {
    const start = match.index ?? 0;
    // Every site is self-closing (<AgentAvatar ... />).
    const tag = source.slice(start, source.indexOf("/>", start));
    const at = tag.indexOf("seed={");
    if (at < 0) {
      seeds.push("<missing>");
      continue;
    }
    let depth = 0;
    let i = at + "seed=".length;
    const from = i + 1;
    for (; i < tag.length; i++) {
      if (tag[i] === "{") depth++;
      else if (tag[i] === "}" && --depth === 0) break;
    }
    seeds.push(tag.slice(from, i).trim());
  }
  return seeds;
}

describe("AgentAvatar render sites", () => {
  it("no site seeds an agent avatar with its raw id (all use avatarSeed ?? id)", () => {
    const found: Array<{ file: string; seed: string }> = [];
    for (const file of sourceFiles(RENDERER_SRC)) {
      const source = readFileSync(file, "utf8");
      for (const seed of avatarSeeds(source)) {
        found.push({ file: relative(RENDERER_SRC, file), seed });
      }
    }
    const offenders = found.filter(({ seed }) => !ALLOWED_SEEDS.some((rule) => rule.test(seed)));
    expect(offenders).toEqual([]);
    // The sites this PR moved to the seed: sidebar, timeline, groups, modal and preview.
    const files = new Set(found.map(({ file }) => file));
    for (const file of [
      "components/Sidebar.tsx",
      "features/agent/MessageBlock.tsx",
      "features/agents/AgentDialog.tsx",
    ]) {
      expect(files.has(file), file).toBe(true);
    }
  });

  it("memberAvatar (group room, popover, sidebar rows) seeds with avatarSeed ?? agentId", () => {
    const base = { agentId: "a-1", avatarFace: "wink", avatarColor: "teal" } as const;
    expect(memberAvatar({ ...base, avatarSeed: "face-calm-40" }).seed).toBe("face-calm-40");
    expect(memberAvatar({ ...base, avatarSeed: null }).seed).toBe("a-1");
    expect(memberAvatar(base).seed).toBe("a-1");
  });
});
