import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  canSaveReadOnlyMcpAllowlist,
  confirmedReadOnlyMcpAllowlist,
  type McpFormState,
  McpServerForm,
  normalizeReadOnlyMcpAllowlist,
  toggleReadOnlyMcpTool,
} from "./SettingsPanel";

function form(overrides: Partial<McpFormState> = {}): McpFormState {
  return {
    originalName: "server",
    scope: "user",
    projectCwd: "C:\\project",
    name: "server",
    transport: "stdio",
    commandLine: "node server.js",
    url: "",
    env: [],
    headers: [],
    enabled: true,
    discoveredTools: ["lookup_raw", "write_raw"],
    readOnlyToolAllowlist: [],
    confirmReadOnlyToolAllowlist: false,
    ...overrides,
  };
}

function renderForm(current: McpFormState): string {
  return renderToStaticMarkup(
    <McpServerForm
      busy={false}
      form={current}
      isNew={false}
      onCancel={() => {}}
      onChange={() => {}}
      projectOptions={[]}
      onSubmit={() => {}}
    />,
  );
}

describe("read-only MCP tool allowlist", () => {
  it("defaults to no allowed names and drops stale names", () => {
    expect(normalizeReadOnlyMcpAllowlist(["lookup_raw", "write_raw"], undefined, true)).toEqual([]);
    expect(
      normalizeReadOnlyMcpAllowlist(
        ["lookup_raw", "write_raw"],
        ["write_raw", "removed_raw", "lookup_raw"],
        true,
      ),
    ).toEqual(["lookup_raw", "write_raw"]);
    expect(normalizeReadOnlyMcpAllowlist(["lookup_raw"], ["lookup_raw"], false)).toEqual([]);
    expect(normalizeReadOnlyMcpAllowlist([], ["stale_raw"], true)).toEqual([]);
  });

  it("toggles only exact discovered raw names", () => {
    expect(
      toggleReadOnlyMcpTool(["lookup_raw", "write_raw"], ["lookup_raw"], "write_raw", true),
    ).toEqual(["lookup_raw", "write_raw"]);
    expect(
      toggleReadOnlyMcpTool(
        ["lookup_raw", "write_raw"],
        ["lookup_raw", "write_raw"],
        "lookup_raw",
        false,
      ),
    ).toEqual(["write_raw"]);
    expect(toggleReadOnlyMcpTool([], [], "stale_raw", true)).toEqual([]);
  });

  it("requires a separate confirmation before saving a non-empty allowlist", () => {
    expect(canSaveReadOnlyMcpAllowlist([], false)).toBe(true);
    expect(canSaveReadOnlyMcpAllowlist(["lookup_raw"], false)).toBe(false);
    expect(canSaveReadOnlyMcpAllowlist(["lookup_raw"], true)).toBe(true);
  });

  it("persists only checked exact raw names after confirmation", () => {
    expect(
      confirmedReadOnlyMcpAllowlist(
        ["lookup_raw", "write_raw"],
        ["write_raw", "stale_raw"],
        true,
        true,
      ),
    ).toEqual(["write_raw"]);
    expect(
      confirmedReadOnlyMcpAllowlist(["lookup_raw"], ["lookup_raw"], false, true),
    ).toBeUndefined();
  });

  it("shows exact discovered names, persisted selection, and confirmation-gated Save", () => {
    const markup = renderForm(form({ readOnlyToolAllowlist: ["write_raw"] }));

    expect(markup).toContain("Read-only tools");
    expect(markup).toContain("lookup_raw");
    expect(markup).toContain("write_raw");
    expect(markup).toContain("Confirm selected tools are read-only");
    expect(markup).toContain("Only checked raw tool names are saved.");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("mcp_server_lookup_raw");
    const checkboxes = markup.match(/<input aria-label="Allow [^"]+"[^>]*>/g) ?? [];
    expect(checkboxes[0]).not.toContain("checked=");
    expect(checkboxes[1]).toContain('aria-label="Allow write_raw as read-only"');
    expect(checkboxes[1]).toContain('checked=""');
  });

  it("renders discovered names unchecked when no allowlist is configured", () => {
    const markup = renderForm(form());
    const toolCheckboxes = markup.match(/<input aria-label="Allow [^"]+"[^>]*>/g) ?? [];

    expect(toolCheckboxes).toHaveLength(2);
    expect(toolCheckboxes.every((checkbox) => !checkbox.includes("checked="))).toBe(true);
    expect(markup).not.toContain("Confirm selected tools are read-only");
  });

  it("shows tool discovery unavailable and leaves the allowlist empty", () => {
    const markup = renderForm(
      form({ discoveredTools: [], readOnlyToolAllowlist: [], confirmReadOnlyToolAllowlist: false }),
    );

    expect(markup).toContain("Tool list unavailable");
    expect(markup).toContain("No tools are allowed by default.");
    expect(markup).not.toContain('aria-label="Allow ');
  });
});
