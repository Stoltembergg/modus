import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessContext } from "../../kernel/harness-hooks";
import { SkillsSectionProvider } from "./skills-section";

describe("SkillsSectionProvider", () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("lists bundled and workspace skills alongside active tools", () => {
    cwd = mkdtempSync(join(tmpdir(), "modus-skills-section-"));
    const skillDir = join(cwd, ".modus", "skills", "workspace-review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: workspace-review\ndescription: Workspace skill marker\n---\nPRIVATE BODY",
      "utf8",
    );
    const context = {
      cwd,
      sessionId: "skills-section",
      runId: "skills-section-run",
      mode: "build",
      state: new Map([["activeTools", ["read"]]]),
    } satisfies HarnessContext;

    const content = new SkillsSectionProvider().buildContent(context);

    expect(content).toContain("- read");
    expect(content).toContain("workspace-review: Workspace skill marker");
    expect(content).toContain("browser");
    for (const name of [
      "brainstorming",
      "diagnosing-superpowers",
      "dispatching-parallel-agents",
      "executing-plans",
      "finishing-a-development-branch",
      "receiving-code-review",
      "requesting-code-review",
      "reverse-engineer-anything",
      "subagent-driven-development",
      "systematic-debugging",
      "test-driven-development",
      "using-git-worktrees",
      "using-superpowers",
      "verification-before-completion",
      "writing-plans",
      "writing-skills",
    ]) {
      expect(content).toContain(`- ${name}:`);
    }
    expect(content).not.toContain("PRIVATE BODY");
  });

  it("keeps the REA adapter in the bundled skill and directs Modus to its broker", () => {
    const skill = readFileSync(
      new URL(
        "../../../../../../resources/skills/reverse-engineer-anything/SKILL.md",
        import.meta.url,
      ),
      "utf8",
    );
    expect(skill).toContain("## Modus adapter");
    expect(skill).toContain("`rea_tools`");
    expect(skill).toContain("`rea_call`");
    expect(skill).toContain("Do not run setup or modify");
    expect(skill).toContain("another client's MCP configuration");
  });
});
