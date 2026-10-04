import { beforeEach, describe, expect, it, vi } from "vitest";

const checkoutBranch = vi.fn(async () => ({ kind: "ok" as const, output: "" }));
vi.mock("../git/git-service", () => ({ checkoutBranch, listBranches: vi.fn() }));
vi.mock("./agent-run-store", () => ({ getActiveAgentRun: vi.fn() }));
vi.mock("./agent-store", () => ({
  getAgentSession: vi.fn(),
  getAgentSessionBranch: vi.fn(),
  setAgentSessionBranch: vi.fn(),
}));

const { createSessionBranchDeps } = await import("./session-branch-deps");

beforeEach(() => checkoutBranch.mockClear());

describe("L2 session-branch deps", () => {
  it("the session picker is the only switcher that asks git-service for a clean tree", async () => {
    const deps = createSessionBranchDeps({ emit: vi.fn() });
    await deps.checkout("/repo", "feat/l2");
    expect(checkoutBranch).toHaveBeenCalledWith("/repo", "feat/l2", false, { requireClean: true });
  });
});
