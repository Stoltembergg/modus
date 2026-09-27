import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ProjectMemoryExternalReference,
  ProjectMemoryRecord,
  ProjectMemoryScope,
  ProjectMemorySnapshot,
  ProjectMemoryVerification,
} from "../../../../shared/contracts";
import {
  confirmProjectMemoryRemoval,
  groupProjectMemories,
  ProjectMemoryRow,
  projectMemoryProvisionalExplanation,
  projectMemoryStatusLabel,
  projectMemoryVerificationLabel,
  projectMemoryVerifyVisible,
  safeExternalReferenceUrl,
  setProjectMemoryScopeEnabled,
} from "./SettingsPanel";

const record = (
  id: string,
  scope: ProjectMemoryScope,
  overrides: Partial<ProjectMemoryRecord> = {},
): ProjectMemoryRecord => ({
  id,
  scope,
  category: "decision",
  title: id,
  claim: `${id} claim`,
  status: "active",
  verification: "tests_passed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  evidence: [{ kind: "run" }],
  ...overrides,
});

const snapshot = (memories: ProjectMemoryRecord[]): ProjectMemorySnapshot => ({
  globalEnabled: true,
  projectEnabled: true,
  memories,
});

const externalMemory = (
  reference: ProjectMemoryExternalReference,
  overrides: Partial<ProjectMemoryRecord> = {},
): ProjectMemoryRecord =>
  record(
    "external",
    { kind: "global" },
    {
      status: "needs_review",
      verification: "unverified",
      evidence: [{ kind: "external_reference", externalReference: reference }],
      ...overrides,
    },
  );

function renderMemory(memory: ProjectMemoryRecord): string {
  return renderToStaticMarkup(
    createElement(ProjectMemoryRow, {
      memory,
      busy: false,
      onVerify: () => {},
      onRemove: () => {},
    }),
  );
}

describe("groupProjectMemories", () => {
  it("returns global and matching project records, excluding other projects", () => {
    const groups = groupProjectMemories(
      [
        record("global", { kind: "global" }),
        record("current", { kind: "project", workspaceId: "ws-a" }),
        record("other", { kind: "project", workspaceId: "ws-b" }),
      ],
      "ws-a",
    );
    expect(groups.global.map(({ id }) => id)).toEqual(["global"]);
    expect(groups.project.map(({ id }) => id)).toEqual(["current"]);
  });

  it("shows only global records in Inbox", () => {
    const groups = groupProjectMemories(
      [
        record("global", { kind: "global" }),
        record("inbox", { kind: "project", workspaceId: "modus-inbox-chats" }),
      ],
      "modus-inbox-chats",
    );
    expect(groups.global.map(({ id }) => id)).toEqual(["global"]);
    expect(groups.project).toEqual([]);
  });
});

describe("project memory trust labels", () => {
  it("uses clear status labels and only offers Verify for provisional or needs-review records", () => {
    expect(projectMemoryStatusLabel("provisional")).toBe("Provisional");
    expect(projectMemoryStatusLabel("needs_review")).toBe("Needs review");
    expect(projectMemoryVerifyVisible("provisional")).toBe(true);
    expect(projectMemoryVerifyVisible("needs_review")).toBe(true);
    expect(projectMemoryVerifyVisible("active")).toBe(false);
    expect(projectMemoryVerifyVisible("obsolete")).toBe(false);
  });

  it("explains provisional child/worktree findings are excluded from automatic context", () => {
    expect(projectMemoryProvisionalExplanation()).toContain("child/worktree");
    expect(projectMemoryProvisionalExplanation()).toContain(
      "excluded from automatic memory context",
    );
    expect(projectMemoryProvisionalExplanation()).toContain(
      "parent-checkout verification or integration",
    );
  });

  it.each([
    ["user_explicit", "User explicit"],
    ["agent_observed", "Agent observed"],
    ["tests_passed", "Tests passed"],
    ["parent_verified", "Parent verified"],
    ["unverified", "Unverified"],
  ] as const)("labels %s verification as %s", (verification, expected) => {
    expect(projectMemoryVerificationLabel(verification satisfies ProjectMemoryVerification)).toBe(
      expected,
    );
  });
});

describe("external project-memory references", () => {
  it("renders agent-supplied references as untrusted links with needs-review status only", () => {
    const reference = {
      url: "https://example.test/account-security",
      title: "Account security guide",
      sourceLabel: "Agent-supplied",
      retrievedAt: "2026-09-01T00:00:00.000Z",
      origin: "agent_supplied_unverified",
      excerpt: "COPIED_PAGE_BODY_MUST_NOT_RENDER",
    } as ProjectMemoryExternalReference;
    const markup = renderMemory(externalMemory(reference));

    expect(markup).toContain('href="https://example.test/account-security"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("Account security guide");
    expect(markup).toContain("https://example.test/account-security");
    expect(markup).toContain("Agent-supplied");
    expect(markup).toContain("Untrusted external reference");
    expect(markup).toContain("Needs review");
    expect(markup).not.toContain("Verified external");
    expect(markup).not.toContain("COPIED_PAGE_BODY_MUST_NOT_RENDER");
  });

  it("shows only the typed source label for MCP-attested metadata without trust claims", () => {
    const markup = renderMemory(
      externalMemory({
        url: "https://docs.example.test/api",
        sourceLabel: "Docs Search",
        retrievedAt: "2026-09-01T00:00:00.000Z",
        origin: "mcp_attested",
      }),
    );

    expect(markup).toContain("Docs Search");
    expect(markup).toContain("Untrusted external reference");
    expect(markup).not.toContain("MCP attested");
    expect(markup).not.toContain("Verified source");
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pass@example.test/",
  ])("does not create a link for unsafe URL %s", (url) => {
    expect(safeExternalReferenceUrl(url)).toBeUndefined();
    const markup = renderMemory(
      externalMemory({
        url,
        sourceLabel: "Agent-supplied",
        retrievedAt: "2026-09-01T00:00:00.000Z",
        origin: "agent_supplied_unverified",
      }),
    );
    expect(markup).not.toContain("<a ");
  });

  it("bounds long titles and URLs to a single ellipsized line", () => {
    const longValue = `https://example.test/${"long-path-segment-".repeat(20)}`;
    const markup = renderMemory(
      externalMemory({
        url: longValue,
        title: "A very long external reference title ".repeat(10),
        sourceLabel: "Agent-supplied",
        retrievedAt: "2026-09-01T00:00:00.000Z",
        origin: "agent_supplied_unverified",
      }),
    );

    expect(markup).toContain("truncate");
    expect(markup).toContain("max-w-full");
  });
});

describe("setProjectMemoryScopeEnabled", () => {
  it("updates the selected scope and persists the toggle", async () => {
    const initial = snapshot([]);
    const onSnapshot = vi.fn();
    const persist = vi.fn(async () => ({ ...initial, projectEnabled: false }));

    await setProjectMemoryScopeEnabled({
      snapshot: initial,
      scope: { kind: "project", workspaceId: "ws-a" },
      enabled: false,
      onSnapshot,
      persist,
    });

    expect(onSnapshot).toHaveBeenNthCalledWith(1, { ...initial, projectEnabled: false });
    expect(persist).toHaveBeenCalledWith({
      scope: { kind: "project", workspaceId: "ws-a" },
      enabled: false,
    });
    expect(onSnapshot).toHaveBeenLastCalledWith({ ...initial, projectEnabled: false });
  });

  it("restores the previous state if persistence fails", async () => {
    const initial = snapshot([]);
    const onSnapshot = vi.fn();
    await expect(
      setProjectMemoryScopeEnabled({
        snapshot: initial,
        scope: { kind: "global" },
        enabled: false,
        onSnapshot,
        persist: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect(onSnapshot).toHaveBeenLastCalledWith(initial);
  });
});

describe("confirmProjectMemoryRemoval", () => {
  it("runs the chosen action only after confirmation", async () => {
    const confirm = vi.fn().mockReturnValue(false);
    const remove = vi.fn();
    await expect(confirmProjectMemoryRemoval("mem-1", "delete", confirm, remove)).resolves.toBe(
      false,
    );
    expect(remove).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await expect(confirmProjectMemoryRemoval("mem-1", "obsolete", confirm, remove)).resolves.toBe(
      true,
    );
    expect(remove).toHaveBeenCalledWith("mem-1", "obsolete");
  });
});
