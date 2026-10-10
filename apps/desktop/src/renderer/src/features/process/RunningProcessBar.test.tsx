// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedProcessInfo } from "../../../../shared/contracts";
import { RunningProcessBar } from "./RunningProcessBar";

afterEach(cleanup);

const processInfo: ManagedProcessInfo = {
  id: "app-1",
  kind: "app",
  origin: "agent",
  label: "editor",
  status: "running",
  startedAt: "2026-10-10T00:00:00.000Z",
};

async function expandBar(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "1 background terminal" }));
  });
}

describe("RunningProcessBar", () => {
  it("shows a failed stop request instead of leaving its IPC rejection unhandled", async () => {
    const onStop = vi.fn().mockRejectedValue(new Error("termination was not confirmed"));
    render(<RunningProcessBar nowMs={Date.now()} onStop={onStop} processes={[processInfo]} />);
    await expandBar();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop editor" }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("editor: termination was not confirmed");
    });
    expect(onStop).toHaveBeenCalledWith("app-1");
  });

  it("allows only one outstanding stop request per process row", async () => {
    let resolveStop: (stopped: boolean) => void = () => undefined;
    const onStop = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveStop = resolve;
        }),
    );
    render(<RunningProcessBar nowMs={Date.now()} onStop={onStop} processes={[processInfo]} />);
    await expandBar();
    const button = screen.getByRole("button", { name: "Stop editor" }) as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(onStop).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    await act(async () => resolveStop(true));
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});
