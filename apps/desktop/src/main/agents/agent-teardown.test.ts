import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateAgentGroupMembersInput } from "../../shared/contracts";
import { deleteAgentSessionTree } from "../agent/session-lifecycle";
import { deleteAgentGroup, removeAgentFromGroup } from "../groups/group-store";
import {
  deleteAgentWithSessions,
  deleteGroupWithSessions,
  removeMemberWithSessions,
  teardownDetachedSessions,
  updateMembersWithSessions,
} from "./agent-teardown";
import { deleteAgent, updateGroupMembers } from "./agents-store";

vi.mock("../agent/session-lifecycle");
vi.mock("../groups/group-store");
vi.mock("./agents-store");

describe("agent-teardown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("teardownDetachedSessions", () => {
    it("calls deleteAgentSessionTree for each sessionId", async () => {
      vi.mocked(deleteAgentSessionTree).mockResolvedValue();
      await teardownDetachedSessions(["session-1", "session-2"]);
      expect(deleteAgentSessionTree).toHaveBeenCalledTimes(2);
      expect(deleteAgentSessionTree).toHaveBeenNthCalledWith(1, "session-1");
      expect(deleteAgentSessionTree).toHaveBeenNthCalledWith(2, "session-2");
    });

    it("continues if deleteAgentSessionTree fails", async () => {
      vi.mocked(deleteAgentSessionTree).mockRejectedValueOnce(new Error("Test error"));
      vi.mocked(deleteAgentSessionTree).mockResolvedValue();

      const consoleWarnMock = vi.spyOn(console, "warn").mockImplementation(() => {});

      await teardownDetachedSessions(["session-1", "session-2"]);

      expect(deleteAgentSessionTree).toHaveBeenCalledTimes(2);
      expect(consoleWarnMock).toHaveBeenCalledWith(
        "[modus] agent session teardown failed:",
        expect.any(Error),
      );

      consoleWarnMock.mockRestore();
    });
  });

  describe("deleteAgentWithSessions", () => {
    it("calls deleteAgent and then teardownDetachedSessions", async () => {
      vi.mocked(deleteAgent).mockReturnValue(["session-1", "session-2"]);
      vi.mocked(deleteAgentSessionTree).mockResolvedValue();

      await deleteAgentWithSessions("agent-1");

      expect(deleteAgent).toHaveBeenCalledWith("agent-1");
      expect(deleteAgentSessionTree).toHaveBeenCalledTimes(2);
      expect(deleteAgentSessionTree).toHaveBeenNthCalledWith(1, "session-1");
      expect(deleteAgentSessionTree).toHaveBeenNthCalledWith(2, "session-2");
    });

    it("throws if deleteAgent throws, without tearing down", async () => {
      vi.mocked(deleteAgent).mockImplementation(() => {
        throw new Error("Store error");
      });

      let error: Error | undefined;
      try {
        await deleteAgentWithSessions("agent-1");
      } catch (e) {
        if (e instanceof Error) {
          error = e;
        } else {
          error = new Error(String(e));
        }
      }
      expect(error).toBeDefined();
      expect(error?.message).toBe("Store error");
      expect(deleteAgentSessionTree).not.toHaveBeenCalled();
    });
  });

  describe("deleteGroupWithSessions", () => {
    it("calls deleteAgentGroup and then teardownDetachedSessions", async () => {
      vi.mocked(deleteAgentGroup).mockReturnValue(["session-1", "session-2"]);
      vi.mocked(deleteAgentSessionTree).mockResolvedValue();

      await deleteGroupWithSessions("group-1");

      expect(deleteAgentGroup).toHaveBeenCalledWith("group-1");
      expect(deleteAgentSessionTree).toHaveBeenCalledTimes(2);
      expect(deleteAgentSessionTree).toHaveBeenNthCalledWith(1, "session-1");
      expect(deleteAgentSessionTree).toHaveBeenNthCalledWith(2, "session-2");
    });

    it("throws if deleteAgentGroup throws, without tearing down", async () => {
      vi.mocked(deleteAgentGroup).mockImplementation(() => {
        throw new Error("Store error");
      });

      let error: Error | undefined;
      try {
        await deleteGroupWithSessions("group-1");
      } catch (e) {
        if (e instanceof Error) {
          error = e;
        } else {
          error = new Error(String(e));
        }
      }
      expect(error).toBeDefined();
      expect(error?.message).toBe("Store error");
      expect(deleteAgentSessionTree).not.toHaveBeenCalled();
    });
  });

  describe("removeMemberWithSessions", () => {
    it("calls removeAgentFromGroup and then teardownDetachedSessions", async () => {
      vi.mocked(removeAgentFromGroup).mockReturnValue(["session-1"]);
      vi.mocked(deleteAgentSessionTree).mockResolvedValue();

      await removeMemberWithSessions("group-1", "session-1");

      expect(removeAgentFromGroup).toHaveBeenCalledWith("group-1", "session-1");
      expect(deleteAgentSessionTree).toHaveBeenCalledTimes(1);
      expect(deleteAgentSessionTree).toHaveBeenCalledWith("session-1");
    });
  });

  describe("updateMembersWithSessions", () => {
    it("calls updateGroupMembers and then teardownDetachedSessions", async () => {
      const mockInput = {
        id: "group-1",
        added: [],
        removed: [],
      } as unknown as UpdateAgentGroupMembersInput;
      const mockGroup = { id: "group-1", members: [] } as unknown as {
        id: string;
        members: unknown[];
      };

      vi.mocked(updateGroupMembers).mockReturnValue({
        // biome-ignore lint/suspicious/noExplicitAny: Mocking return value
        group: mockGroup as any,
        removedSessionIds: ["session-1", "session-2"],
      });
      vi.mocked(deleteAgentSessionTree).mockResolvedValue();

      const result = await updateMembersWithSessions(mockInput);

      expect(updateGroupMembers).toHaveBeenCalledWith(mockInput);
      expect(deleteAgentSessionTree).toHaveBeenCalledTimes(2);
      expect(result).toBe(mockGroup);
    });
  });
});
