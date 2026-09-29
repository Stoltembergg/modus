import { describe, expect, it } from "vitest";
import { CHATS_WORKSPACE_ID } from "./contracts";
import { groupNeedsProject } from "./group-project";

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
