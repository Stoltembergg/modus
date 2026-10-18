// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGroupWithMembers } from "../../../../shared/contracts";
import { MemberRow } from "../../components/sidebar-groups/member-row";
import { groupAgentRows } from "../groups/groupSidebarModel";
import { newGroupMemberSeed } from "../groups/newGroupModel";
import { memberAvatar } from "./agentAvatarModel";

/*
 * Every agent avatar is drawn with `avatarSeed ?? id` (PR #278): the sidebar
 * (chat rows and group member rows), the timeline, the group room and its
 * popover, the New group modal and the dialog preview.
 */

afterEach(cleanup);

const RENDERER_SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The only `seed=` expressions allowed on <AgentAvatar>. Agents go through
 * agentAvatarSeed / memberAvatar(...).seed; drafts through newGroupMemberSeed;
 * the dialog through its preview seed and the 8 face seeds. Template cards are
 * not agents (no stored seed) and keep their template id.
 */
const ALLOWED_SEEDS = [
  /^agentAvatarSeed\(/,
  /^avatar\.seed$/,
  /^row\.seed$/,
  /^newGroupMemberSeed\(member\)$/,
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
      "components/sidebar-groups/member-row.tsx",
      "features/agent/MessageBlock.tsx",
      "features/groups/GroupMessageRow.tsx",
      "features/groups/GroupAgentsPopover.tsx",
      "features/groups/NewGroupModal.tsx",
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

  it("the sidebar group member row draws the stored seed", () => {
    const group: AgentGroupWithMembers = {
      id: "g-1",
      name: "Squad",
      workspaceId: "ws",
      mode: "free",
      createdAt: "now",
      updatedAt: "now",
      members: [
        {
          groupId: "g-1",
          sessionId: "s-1",
          agentId: "a-1",
          name: "Ana",
          agentRole: "",
          joinedAt: "now",
          avatarSeed: "face-wink-29",
        },
        {
          groupId: "g-1",
          sessionId: "s-2",
          agentId: "a-2",
          name: "Bo",
          agentRole: "",
          joinedAt: "now",
        },
      ],
    };
    const rows = groupAgentRows(group, new Map(), undefined);
    expect(rows.map((row) => row.seed)).toEqual(["face-wink-29", "a-2"]);
    const [first] = rows;
    if (!first) throw new Error("expected a row");
    const noop = () => undefined;
    render(
      <MemberRow
        isActive={false}
        label={{ title: "Ana" }}
        onRemove={noop}
        onSelect={noop}
        onToggleLead={noop}
        row={first}
      />,
    );
    expect(screen.getByTestId("agent-avatar").getAttribute("data-seed")).toBe("face-wink-29");
  });

  it("New group modal drafts use their picked seed, else their key", () => {
    expect(newGroupMemberSeed({ key: "k-1", avatarSeed: "face-sleepy-2" })).toBe("face-sleepy-2");
    expect(newGroupMemberSeed({ key: "k-1" })).toBe("k-1");
  });
});
