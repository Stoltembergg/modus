// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionBranchState } from "../../../../shared/contracts";
import { BRANCH_BUSY_TOOLTIP, SessionBranchPicker } from "./SessionBranchPicker";

afterEach(cleanup);

let branchState: SessionBranchState;
const setBranch = vi.fn();

beforeEach(() => {
  branchState = { branch: "main", current: "main", exists: true, running: false };
  setBranch.mockReset().mockImplementation(async ({ branch }: { branch: string }) => ({
    branch,
    current: branch,
    exists: true,
    running: false,
  }));
  (window as unknown as { modus: unknown }).modus = {
    agent: { branchState: vi.fn(async () => branchState), setBranch },
    git: {
      branches: vi.fn(async () => ({
        current: "main",
        local: [
          { name: "main", current: true, remote: false },
          { name: "feat/l2", current: false, remote: false },
        ],
        remote: [{ name: "origin/main", current: false, remote: true }],
      })),
    },
  };
});

describe("SessionBranchPicker (L2)", () => {
  it("shows the session branch and switches by NAME only (no path sent)", async () => {
    render(<SessionBranchPicker cwd="/repo" isRunning={false} sessionId="s1" />);
    const trigger = await screen.findByTestId("session-branch-picker");
    await waitFor(() => expect(trigger.textContent).toContain("main"));
    await act(async () => {
      fireEvent.click(trigger);
    });
    const item = await screen.findByText("feat/l2");
    expect(screen.queryByText("origin/main")).toBeNull(); // no remote refs from the composer
    await act(async () => {
      fireEvent.click(item);
    });
    expect(setBranch).toHaveBeenCalledWith({ sessionId: "s1", branch: "feat/l2" });
    await waitFor(() => expect(trigger.textContent).toContain("feat/l2"));
  });

  it("is disabled with 'Disponível quando o agente terminar' while a run is active", async () => {
    render(<SessionBranchPicker cwd="/repo" isRunning sessionId="s1" />);
    const trigger = await screen.findByTestId("session-branch-picker");
    await waitFor(() => expect(trigger.textContent).toContain("main"));
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute("aria-label")).toBe(BRANCH_BUSY_TOOLTIP);
    expect(trigger.parentElement?.getAttribute("title")).toBe(BRANCH_BUSY_TOOLTIP);
  });

  it("warns and blocks sending when the saved branch no longer exists", async () => {
    branchState = { branch: "gone", current: "main", exists: false, running: false };
    const onBlockedChange = vi.fn();
    render(
      <SessionBranchPicker
        cwd="/repo"
        isRunning={false}
        onBlockedChange={onBlockedChange}
        sessionId="s1"
      />,
    );
    const trigger = await screen.findByTestId("session-branch-picker");
    await waitFor(() => expect(trigger.hasAttribute("data-branch-missing")).toBe(true));
    expect(trigger.parentElement?.getAttribute("title")).toContain('"gone" não existe mais');
    expect(onBlockedChange).toHaveBeenLastCalledWith(true);
  });

  it("surfaces a refused switch (uncommitted changes) without changing the branch", async () => {
    setBranch.mockRejectedValueOnce(new Error("Há alterações não commitadas nesta pasta."));
    const onError = vi.fn();
    render(<SessionBranchPicker cwd="/repo" isRunning={false} onError={onError} sessionId="s1" />);
    const trigger = await screen.findByTestId("session-branch-picker");
    await waitFor(() => expect(trigger.textContent).toContain("main"));
    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.click(await screen.findByText("feat/l2"));
    });
    expect(onError).toHaveBeenCalledWith("Há alterações não commitadas nesta pasta.");
    expect(trigger.textContent).toContain("main");
  });
});
