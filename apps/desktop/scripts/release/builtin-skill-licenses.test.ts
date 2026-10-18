import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import builderConfig from "../../electron-builder.config";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(desktopDir, "../..");
const skillsDir = join(desktopDir, "resources/skills");
const licensesDir = join(desktopDir, "resources/licenses");

/** Modus's own skills, covered by the repository LICENSE. */
const FIRST_PARTY_SKILLS = new Set(["browser"]);

/** Third-party skill folder → its license copy in resources/licenses (byte-identical). */
const SKILL_LICENSES: Record<string, string> = {
  brainstorming: "superpowers-MIT.txt",
  "define-goal": "openai-skills-define-goal-Apache-2.0.txt",
  "diagnosing-superpowers": "superpowers-MIT.txt",
  "dispatching-parallel-agents": "superpowers-MIT.txt",
  "executing-plans": "superpowers-MIT.txt",
  "finishing-a-development-branch": "superpowers-MIT.txt",
  "receiving-code-review": "superpowers-MIT.txt",
  "requesting-code-review": "superpowers-MIT.txt",
  "reverse-engineer-anything": "rea-agents-MIT.txt",
  "subagent-driven-development": "superpowers-MIT.txt",
  "systematic-debugging": "superpowers-MIT.txt",
  "test-driven-development": "superpowers-MIT.txt",
  "using-git-worktrees": "superpowers-MIT.txt",
  "using-superpowers": "superpowers-MIT.txt",
  "verification-before-completion": "superpowers-MIT.txt",
  "writing-plans": "superpowers-MIT.txt",
  "writing-skills": "superpowers-MIT.txt",
};

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function skillFolders(): string[] {
  return readdirSync(skillsDir)
    .filter((name) => statSync(join(skillsDir, name)).isDirectory())
    .sort();
}

function skillLicense(name: string): string | undefined {
  return ["LICENSE", "LICENSE.txt"]
    .map((file) => join(skillsDir, name, file))
    .find((path) => existsSync(path));
}

describe("built-in skill licenses", () => {
  it("every built-in skill is either first-party or has a recorded third-party license", () => {
    const unknown = skillFolders().filter(
      (name) => !FIRST_PARTY_SKILLS.has(name) && !(name in SKILL_LICENSES),
    );
    expect(unknown).toEqual([]);
    for (const name of Object.keys(SKILL_LICENSES)) {
      expect(existsSync(join(skillsDir, name, "SKILL.md")), name).toBe(true);
    }
  });

  it("first-party skills carry no third-party LICENSE", () => {
    for (const name of FIRST_PARTY_SKILLS) expect(skillLicense(name), name).toBeUndefined();
  });

  it.each(
    Object.entries(SKILL_LICENSES),
  )("%s ships a LICENSE identical to resources/licenses/%s", (name, copy) => {
    const license = skillLicense(name);
    expect(license, `${name} has no LICENSE`).toBeDefined();
    expect(sha256(license ?? "")).toBe(sha256(join(licensesDir, copy)));
  });

  it("THIRD_PARTY_NOTICES.md names every third-party skill folder", () => {
    const notices = readFileSync(join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
    for (const name of Object.keys(SKILL_LICENSES)) {
      expect(notices, name).toContain(`apps/desktop/resources/skills/${name}`);
    }
    for (const copy of new Set(Object.values(SKILL_LICENSES))) {
      expect(notices, copy).toContain(`apps/desktop/resources/licenses/${copy}`);
    }
  });

  it("packages the skills folder (licenses included) into the app resources", () => {
    const entries = (builderConfig.extraResources ?? []) as Array<{ from?: string; to?: string }>;
    expect(entries.find((entry) => entry.to === "skills")).toMatchObject({
      from: "resources/skills",
    });
  });
});
