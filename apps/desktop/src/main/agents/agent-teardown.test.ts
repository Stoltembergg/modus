import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAgentSessionTree } from "../agent/session-lifecycle";
import { deleteAgentWithSessions, teardownDetachedSessions } from "./agent-teardown";
import { deleteAgent } from "./agents-store";

vi.mock("../agent/session-lifecycle");
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
});
