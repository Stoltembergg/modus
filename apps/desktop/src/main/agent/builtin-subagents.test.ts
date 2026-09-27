import { describe, expect, it } from "vitest";
import { BUILTIN_SUBAGENTS, getBuiltinSubagentManifest } from "./builtin-subagents";

describe("built-in subagent profiles", () => {
  it("defines six bounded roles with inherited models and explicit sources", () => {
    expect(BUILTIN_SUBAGENTS.map(({ name }) => name)).toEqual([
      "explore",
      "librarian",
      "oracle",
      "reviewer",
      "debugger",
      "ui-ux",
    ]);
    for (const profile of BUILTIN_SUBAGENTS) {
      expect(profile).toMatchObject({ model: "inherit", source: "builtin" });
      expect(profile.description.length).toBeGreaterThan(0);
      expect(profile.tools?.length).toBeGreaterThan(0);
    }
  });

  it("keeps research and review roles read-only and constrains diagnostics", () => {
    for (const name of ["explore", "librarian", "oracle", "reviewer"]) {
      expect(BUILTIN_SUBAGENTS.find((profile) => profile.name === name)?.readOnly).toBe(true);
    }
    const librarian = BUILTIN_SUBAGENTS.find((profile) => profile.name === "librarian");
    expect(librarian?.tools).toContain("web_search");
    expect(librarian?.tools).toContain("web_fetch");
    expect(librarian?.disallowedTools).toContain("mcp");
    const debugProfile = BUILTIN_SUBAGENTS.find((profile) => profile.name === "debugger");
    expect(debugProfile).toMatchObject({
      readOnly: true,
      tools: ["read", "grep", "find", "ls", "fast_codebase"],
    });
    expect(debugProfile?.disallowedTools).toEqual(
      expect.arrayContaining([
        "write",
        "edit",
        "shell",
        "process",
        "terminal_run",
        "terminal_read",
        "terminal_list",
      ]),
    );
    expect(debugProfile?.tools).not.toContain("terminal_run");
    expect(debugProfile?.description).not.toMatch(/run bounded checks|terminal commands/i);
    expect(debugProfile?.body).not.toMatch(/terminal access|diagnostics sandbox|run bounded/i);
  });

  it("keeps UI/UX design read-only with no deferred implementation exception", () => {
    const profile = BUILTIN_SUBAGENTS.find((item) => item.name === "ui-ux");
    expect(profile).toMatchObject({
      readOnly: true,
      isolation: "shared",
      tools: ["read", "grep", "find", "ls", "fast_codebase"],
    });
    expect(profile?.body).not.toMatch(/implementation|worktree|write/i);
    expect(profile?.disallowedTools).toEqual(
      expect.arrayContaining(["shell", "process", "terminal_run", "write", "edit"]),
    );
  });

  it("publishes a compact manifest without profile bodies", () => {
    const manifest = getBuiltinSubagentManifest();
    expect(manifest).toContain("explore");
    expect(manifest).toContain("ui-ux");
    expect(manifest.length).toBeLessThan(2000);
    expect(manifest).not.toContain("<subagent_definition");
  });
});
