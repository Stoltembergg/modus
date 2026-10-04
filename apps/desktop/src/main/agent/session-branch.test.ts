import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, GitBranchSummary } from "../../shared/contracts";
import {
  BRANCH_BUSY_MESSAGE,
  branchContextLine,
  readSessionBranchState,
  type SessionBranchDeps,
  SessionBranchError,
  snapshotRunBranch,
  switchSessionBranch,
} from "./session-branch";

/** In-memory repo + session store driving the L2 session-branch rules. */
function fakeDeps(
  options: { current?: string; branches?: string[]; worktrees?: Record<string, string> } = {},
) {
  const repo = {
    current: options.current ?? "main",
    branches: options.branches ?? ["main", "feat/a"],
    dirty: false,
  };
  const saved = new Map<string, string>();
  const events: AgentEvent[] = [];
  const checkouts: Array<{ cwd: string; name: string }> = [];
  let running = false;
  const deps: SessionBranchDeps = {
    getSession: (id) => (id === "s1" ? { id, cwd: "/repo" } : undefined),
    isRunActive: () => running,
    getSavedBranch: (id) => saved.get(id),
    saveBranch: (id, branch) => saved.set(id, branch),
    listBranches: async (): Promise<GitBranchSummary> => ({
      current: repo.current,
      local: repo.branches.map((name) => ({
        name,
        current: name === repo.current,
        remote: false,
        ...(options.worktrees?.[name] ? { worktreePath: options.worktrees[name] } : {}),
      })),
      remote: [],
    }),
    checkout: vi.fn(async (cwd: string, name: string) => {
      if (repo.dirty) throw new Error("uncommitted changes");
      checkouts.push({ cwd, name });
      repo.current = name;
      return { kind: "ok" as const };
    }),
    emit: (event) => events.push(event),
  };
  return {
    deps,
    repo,
    saved,
    events,
    checkouts,
    setRunning: (value: boolean) => {
      running = value;
    },
  };
}

describe("L2 session branch", () => {
  it("a new session starts on the repo's current branch", async () => {
    const { deps, saved, events } = fakeDeps({ current: "feat/a" });
    expect(await readSessionBranchState(deps, "s1")).toEqual({
      branch: "feat/a",
      current: "feat/a",
      exists: true,
      running: false,
    });
    const snap = await snapshotRunBranch(deps, "s1");
    expect(snap).toEqual({ branch: "feat/a" });
    expect(branchContextLine(snap as { branch: string })).toBe("Branch atual: feat/a");
    expect(saved.get("s1")).toBe("feat/a");
    expect(events).toEqual([]); // adopting the initial branch is not a "switch"
  });

  it("switch while idle: git switch in the SESSION cwd, saved, timeline event, next run uses it", async () => {
    const { deps, events, checkouts, saved } = fakeDeps();
    await snapshotRunBranch(deps, "s1");
    const state = await switchSessionBranch(deps, "s1", "feat/a");
    expect(state).toMatchObject({ branch: "feat/a", exists: true });
    expect(checkouts).toEqual([{ cwd: "/repo", name: "feat/a" }]);
    expect(saved.get("s1")).toBe("feat/a");
    expect(events).toEqual([{ type: "session.branch_changed", sessionId: "s1", branch: "feat/a" }]);
    expect(await snapshotRunBranch(deps, "s1")).toEqual({ branch: "feat/a" });
  });

  it("the run snapshot is immutable and a switch is refused while the run is active", async () => {
    const { deps, setRunning, checkouts, events } = fakeDeps();
    const snap = await snapshotRunBranch(deps, "s1");
    setRunning(true);
    await expect(switchSessionBranch(deps, "s1", "feat/a")).rejects.toThrow(BRANCH_BUSY_MESSAGE);
    expect(checkouts).toEqual([]);
    expect(events).toEqual([]);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      (snap as { branch: string }).branch = "feat/a";
    }).toThrow();
    expect(snap?.branch).toBe("main");
    setRunning(false);
    await switchSessionBranch(deps, "s1", "feat/a");
    expect(snap?.branch).toBe("main"); // the finished run's snapshot never changes
  });

  it("only existing local branch NAMES are accepted (no path, no unknown ref)", async () => {
    const { deps, checkouts } = fakeDeps();
    for (const bad of ["/etc", "../other", "origin/main", "nope"]) {
      await expect(switchSessionBranch(deps, "s1", bad)).rejects.toMatchObject({
        code: "unknown_branch",
      });
    }
    expect(checkouts).toEqual([]);
    await expect(switchSessionBranch(deps, "nope", "main")).rejects.toMatchObject({
      code: "no_session",
    });
  });

  it("uncommitted changes block the switch: nothing saved, no event", async () => {
    const { deps, repo, saved, events } = fakeDeps();
    repo.dirty = true;
    await expect(switchSessionBranch(deps, "s1", "feat/a")).rejects.toThrow("uncommitted");
    expect(saved.has("s1")).toBe(false);
    expect(events).toEqual([]);
    expect(repo.current).toBe("main");
  });

  it("a branch open in another linked worktree is refused (the cwd never moves)", async () => {
    const { deps, checkouts } = fakeDeps({ worktrees: { "feat/a": "/repo/.modus/worktrees/a" } });
    const error = await switchSessionBranch(deps, "s1", "feat/a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionBranchError);
    expect(error).toMatchObject({ code: "worktree", worktreePath: "/repo/.modus/worktrees/a" });
    expect(checkouts).toEqual([]);
  });

  it("a saved branch that no longer exists warns and blocks the next send", async () => {
    const { deps, saved, repo } = fakeDeps();
    saved.set("s1", "gone");
    expect(await readSessionBranchState(deps, "s1")).toMatchObject({
      branch: "gone",
      exists: false,
    });
    await expect(snapshotRunBranch(deps, "s1")).rejects.toMatchObject({ code: "missing_branch" });
    await switchSessionBranch(deps, "s1", "feat/a");
    expect(repo.current).toBe("feat/a");
    expect(await snapshotRunBranch(deps, "s1")).toEqual({ branch: "feat/a" });
  });

  it("a branch changed outside the session is adopted and logged, never misreported", async () => {
    const { deps, repo, events } = fakeDeps();
    await snapshotRunBranch(deps, "s1");
    repo.current = "feat/a"; // e.g. the Changes panel switched
    expect(await snapshotRunBranch(deps, "s1")).toEqual({ branch: "feat/a" });
    expect(events).toEqual([{ type: "session.branch_changed", sessionId: "s1", branch: "feat/a" }]);
  });

  it("detached HEAD / non-git cwd: no snapshot, no context line", async () => {
    const { deps } = fakeDeps();
    deps.listBranches = async () => ({ local: [], remote: [] });
    expect(await snapshotRunBranch(deps, "s1")).toBeUndefined();
    deps.listBranches = async () => {
      throw new Error("not a git repo");
    };
    expect(await snapshotRunBranch(deps, "s1")).toBeUndefined();
  });
});
