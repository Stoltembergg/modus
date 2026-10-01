import { describe, expect, it } from "vitest";
import { CHATS_WORKSPACE_ID } from "./contracts";
import {
  formatGroupProjectContextDetails,
  formatGroupProjectContextLabel,
  groupNeedsProject,
} from "./group-project";

describe("groupNeedsProject", () => {
  it("is true with no workspace (absent or null) and with the Chats inbox id", () => {
    expect(groupNeedsProject({})).toBe(true);
    expect(groupNeedsProject({ workspaceId: null })).toBe(true);
    expect(groupNeedsProject({ workspaceId: "" })).toBe(true);
    expect(groupNeedsProject({ workspaceId: CHATS_WORKSPACE_ID })).toBe(true);
  });

  it("is false for a real Project", () => {
    expect(groupNeedsProject({ workspaceId: "ws-1" })).toBe(false);
  });
});

describe("group project context labels", () => {
  it("formats Mapping… then compact Ready / Updating / Needs refresh", () => {
    expect(formatGroupProjectContextLabel("mapping")).toBe("Mapping project…");
    expect(formatGroupProjectContextLabel("ready")).toBe("Project context · Ready");
    expect(formatGroupProjectContextLabel("updating")).toBe("Project context · Updating");
    expect(formatGroupProjectContextLabel("needs_refresh")).toBe("Project context · Needs refresh");
    expect(formatGroupProjectContextLabel("failed")).toBe("Project context · Needs refresh");
  });

  it("formats Activity diagnostics from a snapshot", () => {
    const lines = formatGroupProjectContextDetails({
      workspaceId: "ws-1",
      status: "ready",
      fingerprint: "abcdef0123456789",
      edgeCount: 12,
      codegraphState: "ready",
      revision: "deadbeefcafebabe",
      updatedAt: "2026-10-01T00:00:00.000Z",
      lastReadyAt: "2026-10-01T00:00:00.000Z",
    });
    expect(lines.some((line) => line.includes("Fingerprint: abcdef012345"))).toBe(true);
    expect(lines.some((line) => line.includes("CodeGraph: ready"))).toBe(true);
    expect(lines.some((line) => line.includes("edges: 12"))).toBe(true);
  });
});
