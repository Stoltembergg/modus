import { CHATS_WORKSPACE_ID, type WorkspaceInfo } from "../../shared/contracts";
import { getWorkspace } from "../workspace/workspace-store";
import {
  type CodeGraphIndexState,
  type CodeGraphRunner,
  ensureCodeGraphIndex,
} from "./fast-codebase-service";

/**
 * Background CodeGraph binary init/sync for project workspaces.
 *
 * Keeps `.codegraph` warm without waiting for a user/agent `fast_codebase` call.
 * Never blocks prompt submission: callers only schedule work; failures are swallowed.
 * Project Model continues to persist discovery hits when tools produce them.
 */

export type CodeGraphAutoSyncReason = "workspace_select" | "manual" | "git_change";

export type CodeGraphAutoSyncOutcome = {
  workspaceId: string;
  cwd: string;
  state: CodeGraphIndexState | "skipped" | "failed";
  reason: CodeGraphAutoSyncReason;
  detail?: string;
};

const DEFAULT_DEBOUNCE_MS = 750;

type Pending = {
  timer: ReturnType<typeof setTimeout>;
  reason: CodeGraphAutoSyncReason;
  cwd?: string;
};

type Flight = {
  promise: Promise<CodeGraphAutoSyncOutcome>;
};

const pendingByWorkspace = new Map<string, Pending>();
const flightsByWorkspace = new Map<string, Flight>();

type AutoSyncDeps = {
  debounceMs: number;
  resolveWorkspace: (workspaceId: string) => WorkspaceInfo | undefined;
  runner: CodeGraphRunner | undefined;
  now: () => number;
};

const deps: AutoSyncDeps = {
  debounceMs: DEFAULT_DEBOUNCE_MS,
  resolveWorkspace: (workspaceId) => {
    try {
      return getWorkspace(workspaceId);
    } catch {
      return undefined;
    }
  },
  runner: undefined,
  now: () => Date.now(),
};

/** Test-only dependency overrides; call `resetCodeGraphAutoSyncForTests` after. */
export function configureCodeGraphAutoSyncForTests(input: {
  debounceMs?: number;
  resolveWorkspace?: (workspaceId: string) => WorkspaceInfo | undefined;
  runner?: CodeGraphRunner | undefined;
  now?: () => number;
}): void {
  if (input.debounceMs !== undefined) deps.debounceMs = input.debounceMs;
  if (input.resolveWorkspace) deps.resolveWorkspace = input.resolveWorkspace;
  if (input.runner !== undefined) deps.runner = input.runner;
  if (input.now) deps.now = input.now;
}

export function resetCodeGraphAutoSyncForTests(): void {
  for (const entry of pendingByWorkspace.values()) {
    clearTimeout(entry.timer);
  }
  pendingByWorkspace.clear();
  flightsByWorkspace.clear();
  deps.debounceMs = DEFAULT_DEBOUNCE_MS;
  deps.resolveWorkspace = (workspaceId) => {
    try {
      return getWorkspace(workspaceId);
    } catch {
      return undefined;
    }
  };
  deps.runner = undefined;
  deps.now = () => Date.now();
}

function shouldSkipWorkspace(workspaceId: string, workspace: WorkspaceInfo | undefined): boolean {
  if (!workspaceId || workspaceId === CHATS_WORKSPACE_ID) return true;
  if (!workspace || workspace.inbox) return true;
  return false;
}

async function runAutoSync(input: {
  workspaceId: string;
  cwd: string;
  reason: CodeGraphAutoSyncReason;
}): Promise<CodeGraphAutoSyncOutcome> {
  try {
    const state = await ensureCodeGraphIndex({
      cwd: input.cwd,
      ...(deps.runner ? { runner: deps.runner } : {}),
    });
    return {
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      state,
      reason: input.reason,
    };
  } catch (error) {
    return {
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      state: "failed",
      reason: input.reason,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function startFlight(input: {
  workspaceId: string;
  cwd: string;
  reason: CodeGraphAutoSyncReason;
}): Promise<CodeGraphAutoSyncOutcome> {
  const existing = flightsByWorkspace.get(input.workspaceId);
  if (existing) {
    return existing.promise;
  }
  const promise = runAutoSync(input).finally(() => {
    flightsByWorkspace.delete(input.workspaceId);
  });
  flightsByWorkspace.set(input.workspaceId, { promise });
  return promise;
}

/**
 * Schedule a non-blocking CodeGraph init/sync for a project workspace.
 * Coalesces bursts (workspace select / git churn) via debounce + single-flight.
 */
export function scheduleCodeGraphAutoSync(input: {
  workspaceId: string;
  reason?: CodeGraphAutoSyncReason;
  cwd?: string;
}): void {
  try {
    const reason = input.reason ?? "manual";
    const workspace = deps.resolveWorkspace(input.workspaceId);
    if (shouldSkipWorkspace(input.workspaceId, workspace)) return;
    const cwd = input.cwd ?? workspace?.rootPath;
    if (!cwd) return;

    const prior = pendingByWorkspace.get(input.workspaceId);
    if (prior) clearTimeout(prior.timer);

    const timer = setTimeout(() => {
      pendingByWorkspace.delete(input.workspaceId);
      void startFlight({
        workspaceId: input.workspaceId,
        cwd,
        reason,
      });
    }, deps.debounceMs);

    pendingByWorkspace.set(input.workspaceId, {
      timer,
      reason,
      cwd,
    });
  } catch {
    // Never surface background sync failures to IPC/prompt paths.
  }
}

/** Await the in-flight or pending sync for tests / explicit flush. */
export async function flushCodeGraphAutoSync(
  workspaceId: string,
): Promise<CodeGraphAutoSyncOutcome | undefined> {
  const pending = pendingByWorkspace.get(workspaceId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingByWorkspace.delete(workspaceId);
    const workspace = deps.resolveWorkspace(workspaceId);
    if (shouldSkipWorkspace(workspaceId, workspace)) return undefined;
    const cwd = pending.cwd ?? workspace?.rootPath;
    if (!cwd) return undefined;
    return startFlight({ workspaceId, cwd, reason: pending.reason });
  }
  const flight = flightsByWorkspace.get(workspaceId);
  if (flight) return flight.promise;
  return undefined;
}

export function isCodeGraphAutoSyncPending(workspaceId: string): boolean {
  return pendingByWorkspace.has(workspaceId) || flightsByWorkspace.has(workspaceId);
}
