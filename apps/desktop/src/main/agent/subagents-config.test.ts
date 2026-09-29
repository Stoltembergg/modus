import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSubagent,
  deleteSubagent,
  listAvailableSubagents,
  listSubagents,
  loadWorkspaceSubagents,
  parseSubagent,
  resolveAvailableSubagent,
  resolveSubagentsPrompt,
  subagentsDir,
  updateSubagent,
} from "./subagents-config";

describe("parseSubagent", () => {
  it("parses Cursor-compatible frontmatter and defaults", () => {
    const agent = parseSubagent(
      "---\nname: Security Auditor\ndescription: Review auth\nreadonly: true\n---\nBody",
      "fallback",
    );

    expect(agent).toEqual({
      name: "security-auditor",
      description: "Review auth",
      model: "inherit",
      readOnly: true,
      isolation: "shared",
      body: "Body",
    });
  });

  it("parses tool filters and worktree isolation", () => {
    const agent = parseSubagent(
      "---\ntools: [read, grep]\ndisallowedTools:\n  - shell\nisolation: worktree\n---\nBody",
      "researcher",
    );

    expect(agent).toMatchObject({
      tools: ["read", "grep"],
      disallowedTools: ["shell"],
      isolation: "worktree",
    });
  });
});

describe("loadWorkspaceSubagents", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "modus-subagents-cwd-"));
    home = mkdtempSync(join(tmpdir(), "modus-subagents-home-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function writeAgent(root: string, name: string, description: string): string {
    const dir = join(root, "agents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.md`);
    writeFileSync(
      path,
      `---\nname: ${name}\ndescription: ${description}\n---\n${description}`,
      "utf8",
    );
    return path;
  }

  it("uses workspace and provider precedence for same-name agents", () => {
    writeAgent(join(home, ".modus"), "reviewer", "home modus");
    writeAgent(join(cwd, ".claude"), "reviewer", "workspace claude");
    const winner = writeAgent(join(cwd, ".modus"), "reviewer", "workspace modus");

    const agents = loadWorkspaceSubagents(cwd, home);

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: "reviewer",
      description: "workspace modus",
      path: winner,
      scope: "workspace",
      source: ".modus",
    });
  });

  it("places built-ins below user overrides and workspace overrides below user overrides", () => {
    expect(resolveAvailableSubagent(cwd, "reviewer", home)).toMatchObject({
      name: "reviewer",
      source: "builtin",
      readOnly: true,
    });

    const user = writeAgent(join(home, ".modus"), "reviewer", "user reviewer");
    expect(resolveAvailableSubagent(cwd, "reviewer", home)).toMatchObject({
      source: "user",
      path: user,
      description: "user reviewer",
    });

    const workspace = writeAgent(join(cwd, ".modus"), "reviewer", "workspace reviewer");
    expect(resolveAvailableSubagent(cwd, "reviewer", home)).toMatchObject({
      source: "workspace",
      path: workspace,
      description: "workspace reviewer",
    });
  });

  it("lists built-ins as non-editable Settings defaults without Markdown CRUD", () => {
    const available = listAvailableSubagents(cwd, home);
    expect(available.map((agent) => agent.name)).toContain("explore");
    expect(available.every((agent) => agent.source === "builtin")).toBe(true);

    const settings = listSubagents(cwd, home);
    expect(settings.map((agent) => agent.name)).toEqual([
      "explore",
      "librarian",
      "oracle",
      "reviewer",
      "debugger",
      "ui-ux",
    ]);
    expect(
      settings.every(
        (agent) =>
          agent.scope === "builtin" &&
          agent.source === "builtin" &&
          !agent.editable &&
          !agent.deletable &&
          agent.path === `builtin:${agent.name}`,
      ),
    ).toBe(true);
  });

  it("hides a built-in from Settings when Markdown overrides the same name", () => {
    writeAgent(join(home, ".modus"), "explore", "custom explore");
    const settings = listSubagents(cwd, home);
    expect(settings.filter((agent) => agent.name === "explore")).toEqual([
      expect.objectContaining({ scope: "user", editable: true }),
    ]);
    expect(settings.some((agent) => agent.path === "builtin:explore")).toBe(false);
  });

  it("preserves generic profile fallback for unknown names", () => {
    expect(resolveAvailableSubagent(cwd, "not-configured", home)).toBeUndefined();
  });

  it("keeps overridden user agents visible for settings management", () => {
    const user = writeAgent(join(home, ".modus"), "reviewer", "home modus");
    const workspace = writeAgent(join(cwd, ".modus"), "reviewer", "workspace modus");

    expect(loadWorkspaceSubagents(cwd, home)).toHaveLength(1);
    expect(listSubagents(cwd, home).filter((agent) => agent.name === "reviewer")).toEqual([
      expect.objectContaining({ path: user, scope: "user" }),
      expect.objectContaining({ path: workspace, scope: "workspace" }),
    ]);
  });

  it("resolves home and workspace Modus agent folders from explicit scope", () => {
    expect(subagentsDir(cwd, "user", home)).toBe(join(home, ".modus", "agents"));
    expect(subagentsDir(cwd, "workspace", home)).toBe(join(cwd, ".modus", "agents"));
  });

  it("renders an empty manifest that prevents invented subagent names", () => {
    const prompt = resolveSubagentsPrompt(cwd, [{ id: "openai/gpt-5.5", name: "GPT 5.5" }]);

    expect(prompt).toContain("built-in defaults");
    expect(prompt).toContain("- explore:");
    expect(prompt).toContain("without the `subagent` field");
    expect(prompt).toContain("do not invent subagent names");
    expect(prompt).toContain("returns immediately");
    expect(prompt).toContain("`wait`");
    expect(prompt).toContain("openai/gpt-5.5");
  });

  it("renders one effective manifest entry when Markdown overrides a built-in", () => {
    writeAgent(join(home, ".modus"), "reviewer", "custom reviewer profile");
    const prompt = resolveSubagentsPrompt(cwd, [], home);

    expect(prompt.match(/- reviewer:/g)).toHaveLength(1);
    expect(prompt).toContain("custom reviewer profile");
    expect(prompt).not.toContain("Review changes for correctness");
  });

  it("clamps UI/UX Markdown capabilities while preserving safe override fields", () => {
    const dir = join(home, ".modus", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ui-ux.md"),
      "---\nname: ui-ux\ndescription: Approved custom description\nmodel: mock/model\nreadonly: false\ntools: [write, shell]\ndisallowedTools: [read]\nisolation: shared\n---\nApproved custom body",
      "utf8",
    );
    const profile = resolveAvailableSubagent(cwd, "ui-ux", home);

    expect(profile).toMatchObject({
      description: "Approved custom description",
      model: "mock/model",
      body: "Approved custom body",
      readOnly: true,
      isolation: "shared",
    });
    expect(profile?.tools).toEqual(["read", "grep", "find", "ls", "fast_codebase"]);
    expect(profile?.disallowedTools).toEqual(
      expect.arrayContaining(["shell", "process", "terminal_run", "write", "edit"]),
    );
  });

  it("creates, updates, deletes, and renders the manifest without bodies", () => {
    const created = createSubagent({
      cwd,
      name: "Security Auditor",
      description: "Review auth",
      model: "mock/model",
      readOnly: true,
      tools: ["read", "grep"],
      disallowedTools: ["shell"],
      isolation: "worktree",
      body: "SECRET BODY",
    });
    expect(readFileSync(created.path, "utf8")).toContain("name: security-auditor");
    expect(readFileSync(created.path, "utf8")).toContain("tools: [read, grep]");

    const updated = updateSubagent({
      cwd,
      path: created.path,
      name: "Security Auditor",
      description: "Review payments",
      model: "inherit",
      readOnly: false,
      isolation: "shared",
      body: "UPDATED BODY",
    });
    expect(updated.description).toBe("Review payments");

    const prompt = resolveSubagentsPrompt(cwd);
    expect(prompt).toContain("security-auditor");
    expect(prompt).toContain("Review payments");
    expect(prompt).toContain("exact name listed below");
    expect(prompt).not.toContain("UPDATED BODY");

    expect(deleteSubagent(cwd, updated.path).filter((agent) => agent.scope !== "builtin")).toEqual(
      [],
    );
  });
});
