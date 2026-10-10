import { describe, expect, it, vi } from "vitest";
import { requestManagedProcessStop } from "./processStopRequest";

describe("requestManagedProcessStop", () => {
  it("reports an unconfirmed stop when the process was already absent", async () => {
    const request = vi.fn().mockResolvedValue(false);
    const reportError = vi.fn();

    requestManagedProcessStop(request, "app-1", reportError);
    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(
        "app-1",
        "Process was no longer tracked or already exited; termination was not confirmed.",
      ),
    );
  });

  it("clears a prior stop notice only after a confirmed stop", async () => {
    const request = vi.fn().mockResolvedValue(true);
    const reportError = vi.fn();
    const onSuccess = vi.fn();

    requestManagedProcessStop(request, "app-1", reportError, onSuccess);
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith("app-1"));
    expect(reportError).not.toHaveBeenCalled();
  });

  it("keeps concurrent stop outcomes attached to their own process id", async () => {
    const notices = new Map<string, string>();
    const request = vi.fn(async (id: string) => id === "app-running");
    const reportError = vi.fn((id: string, message: string) => notices.set(id, message));
    const onSuccess = vi.fn((id: string) => notices.delete(id));

    requestManagedProcessStop(request, "app-running", reportError, onSuccess);
    requestManagedProcessStop(request, "app-gone", reportError, onSuccess);

    await vi.waitFor(() => {
      expect(notices.get("app-gone")).toBe(
        "Process was no longer tracked or already exited; termination was not confirmed.",
      );
    });
    expect(notices.has("app-running")).toBe(false);
    expect(reportError).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith("app-running");
  });

  it("reports IPC rejection instead of leaving it unhandled", async () => {
    const request = vi.fn().mockRejectedValue(new Error("termination was not confirmed"));
    const reportError = vi.fn();

    requestManagedProcessStop(request, "app-1", reportError);
    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith("app-1", "termination was not confirmed"),
    );
    expect(request).toHaveBeenCalledWith("app-1");
  });

  it("also reports a synchronous request failure", async () => {
    const request = vi.fn(() => {
      throw new Error("IPC unavailable");
    });
    const reportError = vi.fn();

    requestManagedProcessStop(request, "app-1", reportError);
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith("app-1", "IPC unavailable"));
  });
});
