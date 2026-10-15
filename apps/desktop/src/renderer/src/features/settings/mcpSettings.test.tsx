// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReaIntegrationStatus } from "../../../../shared/contracts";
import {
  canSaveReadOnlyMcpAllowlist,
  confirmedReadOnlyMcpAllowlist,
  type McpFormState,
  McpServerForm,
  normalizeReadOnlyMcpAllowlist,
  toggleReadOnlyMcpTool,
} from "./SettingsPanel";
import { McpSettingsPanel, ReaIntegrationRow } from "./sections/mcp";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reaStatus = (overrides: Partial<ReaIntegrationStatus> = {}): ReaIntegrationStatus => ({
  enabled: true,
  status: "not_started",
  providerNotes: [],
  ...overrides,
});

function renderRea(status: ReaIntegrationStatus, onToggle = vi.fn(), onRetry = vi.fn()) {
  return {
    ...render(
      <ReaIntegrationRow busy={false} onRetry={onRetry} onToggle={onToggle} status={status} />,
    ),
    onRetry,
    onToggle,
  };
}

describe("built-in REA settings row", () => {
  it("shows the default-enabled state and first-use notice without starting REA", () => {
    const { container } = renderRea(reaStatus());

    expect(screen.getByRole("switch", { name: "Enable REA" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(container.textContent).toContain("Ready when needed");
    expect(container.textContent).toContain("first approved REA tool call");
    expect(container.textContent).toContain("not a sandbox");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows disabled state and no retry control", () => {
    renderRea(reaStatus({ enabled: false, status: "disabled" }));

    expect(screen.getByRole("switch", { name: "Enable REA" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it.each([
    ["needs_node", "Node.js and npm are required."],
    ["network_error", "Couldn’t download REA."],
    ["failed", "REA couldn’t start."],
  ] as const)("shows actionable %s guidance and retry", (status, message) => {
    renderRea(reaStatus({ status, note: "Try again when ready." }));

    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.getByText("Try again when ready.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows provider limitations without hiding an otherwise ready integration", () => {
    renderRea(reaStatus({ status: "ready", providerNotes: ["Ghidra is not available here."] }));

    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText("Ghidra is not available here.")).toBeTruthy();
  });

  it("calls only preference and retry handlers; it never starts an REA worker", () => {
    const { onRetry, onToggle } = renderRea(
      reaStatus({ status: "failed", note: "A sanitized error." }),
    );

    fireEvent.click(screen.getByRole("switch", { name: "Enable REA" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onToggle).toHaveBeenCalledWith(false);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("disables duplicate actions while a preference or retry request is saving", () => {
    render(
      <ReaIntegrationRow
        busy
        onRetry={() => {}}
        onToggle={() => {}}
        status={reaStatus({ status: "failed" })}
      />,
    );

    expect(screen.getByRole("switch", { name: "Enable REA" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Retrying…" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("MCP settings panel integration", () => {
  it("keeps the built-in REA row separate from the generic MCP server controls", () => {
    const markup = renderToStaticMarkup(<McpSettingsPanel cwd={undefined} workspaces={[]} />);

    expect(markup).toContain("Built-in integration");
    expect(markup).toContain("Enable REA");
    expect(markup).toContain("New MCP Server");
    expect(markup).toContain("Global MCP Servers");
  });

  it("uses only the REA preference and retry APIs from the settings controls", async () => {
    const initialStatus = reaStatus({ status: "failed", note: "A sanitized error." });
    const getStatus = vi.fn().mockResolvedValue(initialStatus);
    const setEnabled = vi.fn().mockResolvedValue(reaStatus({ enabled: false, status: "disabled" }));
    const retry = vi.fn().mockResolvedValue(reaStatus());
    vi.stubGlobal("modus", {
      mcp: { list: vi.fn().mockResolvedValue([]) },
      composio: {
        getState: vi.fn().mockResolvedValue({
          apiKeyConfigured: false,
          status: "unconfigured",
          toolkits: [],
        }),
      },
      rea: { getStatus, setEnabled, retry },
    });

    render(<McpSettingsPanel cwd={undefined} workspaces={[]} />);
    await screen.findByText("REA couldn’t start.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("switch", { name: "Enable REA" }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

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
