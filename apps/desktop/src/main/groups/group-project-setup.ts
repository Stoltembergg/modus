import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { GroupProjectContextSnapshot } from "../../shared/contracts";
import { CHATS_WORKSPACE_ID, type WorkspaceInfo } from "../../shared/contracts";
import {
  invalidateProjectModelPaths,
  listProjectModelEdges,
  upsertProjectModelChangedPaths,
  upsertProjectModelDepends,
  upsertProjectModelDiscoveries,
} from "../agent/harness/project-model-store";
import {
  type CodeGraphIndexState,
  ensureCodeGraphIndex,
} from "../fast-codebase/ensure-codegraph-index";
import type { CodeGraphRunner } from "../fast-codebase/fast-codebase-service";
import { getGitMemoryContext } from "../git/git-service";
import { getWorkspace } from "../workspace/workspace-store";
import {
  compareProjectFingerprints,
  computeProjectFingerprint,
  digestBytes,
  isProjectSetupManifestPath,
  PROJECT_SETUP_MANIFEST_PATHS,
} from "./group-project-fingerprint";
import {
  getWorkspaceProjectSetup,
  getWorkspaceProjectSetupMeta,
  upsertWorkspaceProjectSetup,
} from "./group-project-setup-store";

export type GroupProjectSetupReason =
  | "group_create"
  | "workspace_move"
  | "reopen"
  | "git_change"
  | "files_change"
  | "manual";

export type GroupProjectSetupOutcome = {
  workspaceId: string;
  cwd: string;
  snapshot: GroupProjectContextSnapshot;
  reason: GroupProjectSetupReason;
  skipped?: boolean;
};

const DEFAULT_DEBOUNCE_MS = 400;

type Pending = {
  timer: ReturnType<typeof setTimeout>;
  reason: GroupProjectSetupReason;
  cwd?: string;
  groupId?: string;
  changedPaths?: string[];
};

type Flight = {
  promise: Promise<GroupProjectSetupOutcome>;
};

const pendingByWorkspace = new Map<string, Pending>();
const flightsByWorkspace = new Map<string, Flight>();
/** cwd → workspaceId for files-watcher incremental hooks. */
const workspaceByCwd = new Map<string, string>();

type SetupListener = (event: {
  workspaceId: string;
  groupId?: string;
  snapshot: GroupProjectContextSnapshot;
}) => void;

const listeners = new Set<SetupListener>();

type SetupDeps = {
  debounceMs: number;
  resolveWorkspace: (workspaceId: string) => WorkspaceInfo | undefined;
  runner: CodeGraphRunner | undefined;
  readGit: typeof getGitMemoryContext;
  ensureIndex: typeof ensureCodeGraphIndex;
  now: () => number;
};

const deps: SetupDeps = {
  debounceMs: DEFAULT_DEBOUNCE_MS,
  resolveWorkspace: (workspaceId) => {
    try {
      return getWorkspace(workspaceId);
    } catch {
      return undefined;
    }
  },
  runner: undefined,
  readGit: getGitMemoryContext,
  ensureIndex: ensureCodeGraphIndex,
  now: () => Date.now(),
};

/** Test-only dependency overrides; call `resetGroupProjectSetupForTests` after. */
export function configureGroupProjectSetupForTests(input: {
  debounceMs?: number;
  resolveWorkspace?: (workspaceId: string) => WorkspaceInfo | undefined;
  runner?: CodeGraphRunner | undefined;
  readGit?: typeof getGitMemoryContext;
  ensureIndex?: typeof ensureCodeGraphIndex;
  now?: () => number;
}): void {
  if (input.debounceMs !== undefined) deps.debounceMs = input.debounceMs;
  if (input.resolveWorkspace) deps.resolveWorkspace = input.resolveWorkspace;
  if (input.runner !== undefined) deps.runner = input.runner;
  if (input.readGit) deps.readGit = input.readGit;
  if (input.ensureIndex) deps.ensureIndex = input.ensureIndex;
  if (input.now) deps.now = input.now;
}

export function resetGroupProjectSetupForTests(): void {
  for (const entry of pendingByWorkspace.values()) clearTimeout(entry.timer);
  pendingByWorkspace.clear();
  flightsByWorkspace.clear();
  workspaceByCwd.clear();
  listeners.clear();
  deps.debounceMs = DEFAULT_DEBOUNCE_MS;
  deps.resolveWorkspace = (workspaceId) => {
    try {
      return getWorkspace(workspaceId);
    } catch {
      return undefined;
    }
  };
  deps.runner = undefined;
  deps.readGit = getGitMemoryContext;
  deps.ensureIndex = ensureCodeGraphIndex;
  deps.now = () => Date.now();
}

export function onGroupProjectSetup(listener: SetupListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitSetup(input: {
  workspaceId: string;
  groupId?: string;
  snapshot: GroupProjectContextSnapshot;
}): void {
  for (const listener of listeners) {
    try {
      listener(input);
    } catch {
      // Listeners must not break Setup.
    }
  }
}

function shouldSkipWorkspace(workspaceId: string, workspace: WorkspaceInfo | undefined): boolean {
  if (!workspaceId || workspaceId === CHATS_WORKSPACE_ID) return true;
  if (!workspace || workspace.inbox) return true;
  return false;
}

function registerCwd(workspaceId: string, cwd: string): void {
  try {
    workspaceByCwd.set(resolve(cwd), workspaceId);
  } catch {
    workspaceByCwd.set(cwd, workspaceId);
  }
}

/** Map an absolute or relative changed path to a workspace-relative path. */
function toRelativePath(cwd: string, path: string): string | undefined {
  try {
    const abs = resolve(path);
    const root = resolve(cwd);
    const rel = relative(root, abs);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(".."))
      return undefined;
    return rel.replace(/\\/g, "/");
  } catch {
    return undefined;
  }
}

function collectManifestDigests(cwd: string): Array<{ path: string; digest: string }> {
  const rows: Array<{ path: string; digest: string }> = [];
  for (const path of PROJECT_SETUP_MANIFEST_PATHS) {
    const abs = join(cwd, path);
    try {
      if (!existsSync(abs)) continue;
      const st = statSync(abs);
      if (st.isDirectory()) {
        // Fingerprint directory presence only (e.g. .cursor/rules).
        rows.push({ path, digest: digestBytes(`dir:${st.mtimeMs}`) });
        continue;
      }
      rows.push({ path, digest: digestBytes(readFileSync(abs)) });
    } catch {
      // Missing / unreadable manifests are omitted from the fingerprint.
    }
  }
  return rows;
}

function seedStructuralEdges(input: {
  workspaceId: string;
  cwd: string;
  revision: string;
  changedPaths: string[];
}): number {
  const discoveryHits: Array<{ path: string }> = [];
  const depends: Array<{ fromPath: string; toPath: string }> = [];

  for (const path of PROJECT_SETUP_MANIFEST_PATHS) {
    if (existsSync(join(input.cwd, path))) discoveryHits.push({ path });
  }

  const pkgPath = join(input.cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        main?: unknown;
        module?: unknown;
        bin?: unknown;
        scripts?: Record<string, unknown>;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      for (const key of ["main", "module"] as const) {
        const value = pkg[key];
        if (typeof value === "string" && value.trim()) {
          discoveryHits.push({ path: value.replace(/^\.\//, "") });
        }
      }
      if (pkg.bin && typeof pkg.bin === "object") {
        for (const value of Object.values(pkg.bin)) {
          if (typeof value === "string" && value.trim()) {
            discoveryHits.push({ path: value.replace(/^\.\//, "") });
          }
        }
      }
      if (pkg.scripts && typeof pkg.scripts === "object") {
        discoveryHits.push({ path: "package.json#scripts" });
      }
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const name of Object.keys(deps).slice(0, 200)) {
        const safe = name.replace(/[^A-Za-z0-9@/._+-]/g, "").slice(0, 120);
        if (!safe) continue;
        depends.push({ fromPath: "package.json", toPath: `deps/${safe}` });
      }
    } catch {
      // Malformed package.json — still keep the discovery hit for the file itself.
    }
  }

  let written = upsertProjectModelDiscoveries({
    workspaceId: input.workspaceId,
    revision: input.revision,
    hits: discoveryHits,
  });
  written += upsertProjectModelDepends({
    workspaceId: input.workspaceId,
    revision: input.revision,
    edges: depends,
    source: "checkpoint",
  });
  if (input.changedPaths.length > 0) {
    written += upsertProjectModelChangedPaths({
      workspaceId: input.workspaceId,
      revision: input.revision,
      paths: input.changedPaths,
    });
  }
  return written;
}

async function runSetup(input: {
  workspaceId: string;
  cwd: string;
  reason: GroupProjectSetupReason;
  groupId?: string;
  changedPaths?: string[];
}): Promise<GroupProjectSetupOutcome> {
  const relativeChanged = (input.changedPaths ?? [])
    .map((path) => toRelativePath(input.cwd, path) ?? path.replace(/\\/g, "/"))
    .filter((path) => path.length > 0 && !path.includes(".."))
    .slice(0, 500);

  const git: {
    branch?: string;
    head?: string;
    changedPaths: string[];
  } = await deps.readGit(input.cwd).catch(() => ({ changedPaths: [] as string[] }));
  const manifests = collectManifestDigests(input.cwd);
  const liveFingerprint = computeProjectFingerprint({
    ...(git.branch ? { branch: git.branch } : {}),
    ...(git.head ? { head: git.head } : {}),
    manifests,
  });
  const revision = (git.head ?? "nogit").replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64) || "nogit";
  const stored = getWorkspaceProjectSetupMeta(input.workspaceId);
  const compatibility = stored
    ? compareProjectFingerprints({
        stored: stored.fingerprint,
        live: liveFingerprint,
        ...(stored.branch ? { storedBranch: stored.branch } : {}),
        ...(git.branch ? { liveBranch: git.branch } : {}),
        ...(stored.head ? { storedHead: stored.head } : {}),
        ...(git.head ? { liveHead: git.head } : {}),
      })
    : "mismatch";

  // Reopen / select with identical fingerprint → reuse Ready without rework.
  if (
    (input.reason === "reopen" || input.reason === "manual") &&
    compatibility === "match" &&
    stored?.status === "ready"
  ) {
    const snapshot = getWorkspaceProjectSetup(input.workspaceId);
    if (!snapshot) {
      // Fall through to a fresh Setup if the row disappeared between reads.
    } else {
      emitSetup({
        workspaceId: input.workspaceId,
        ...(input.groupId ? { groupId: input.groupId } : {}),
        snapshot,
      });
      return {
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        snapshot,
        reason: input.reason,
        skipped: true,
      };
    }
  }

  const mappingStatus =
    input.reason === "group_create" || !stored
      ? "mapping"
      : compatibility === "mismatch"
        ? "needs_refresh"
        : "updating";

  let snapshot = upsertWorkspaceProjectSetup({
    workspaceId: input.workspaceId,
    fingerprint: liveFingerprint,
    status: mappingStatus,
    edgeCount:
      listProjectModelEdges(input.workspaceId, undefined, 1).length > 0
        ? listProjectModelEdges(input.workspaceId).length
        : 0,
    detail: `setup:${input.reason}`,
    revision,
    ...(git.branch ? { branch: git.branch } : {}),
    ...(git.head ? { head: git.head } : {}),
  });
  emitSetup({
    workspaceId: input.workspaceId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    snapshot,
  });

  try {
    if (
      compatibility === "partial" ||
      input.reason === "files_change" ||
      input.reason === "git_change"
    ) {
      const invalidatePaths = [
        ...relativeChanged,
        ...git.changedPaths,
        ...manifests
          .filter((row) =>
            relativeChanged.some((path) => isProjectSetupManifestPath(path) || path === row.path),
          )
          .map((row) => row.path),
      ];
      if (invalidatePaths.length > 0) {
        invalidateProjectModelPaths(input.workspaceId, invalidatePaths);
      }
    }

    let codegraphState: CodeGraphIndexState | "failed" = "ready";
    try {
      codegraphState = await deps.ensureIndex({
        cwd: input.cwd,
        ...(deps.runner ? { runner: deps.runner } : {}),
      });
    } catch (error) {
      codegraphState = "failed";
      snapshot = upsertWorkspaceProjectSetup({
        workspaceId: input.workspaceId,
        fingerprint: liveFingerprint,
        status: "updating",
        codegraphState: "failed",
        edgeCount: listProjectModelEdges(input.workspaceId).length,
        detail: error instanceof Error ? error.message : String(error),
        revision,
        ...(git.branch ? { branch: git.branch } : {}),
        ...(git.head ? { head: git.head } : {}),
      });
    }

    const changedForSeed = [...new Set([...relativeChanged, ...(git.changedPaths ?? [])])].slice(
      0,
      500,
    );
    seedStructuralEdges({
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      revision,
      changedPaths: changedForSeed,
    });

    const edgeCount = listProjectModelEdges(input.workspaceId).length;
    snapshot = upsertWorkspaceProjectSetup({
      workspaceId: input.workspaceId,
      fingerprint: liveFingerprint,
      status: "ready",
      codegraphState: String(codegraphState),
      edgeCount,
      detail: `setup:${input.reason}:ok`,
      revision,
      ...(git.branch ? { branch: git.branch } : {}),
      ...(git.head ? { head: git.head } : {}),
      markReady: true,
    });
    emitSetup({
      workspaceId: input.workspaceId,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      snapshot,
    });
    return {
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      snapshot,
      reason: input.reason,
    };
  } catch (error) {
    snapshot = upsertWorkspaceProjectSetup({
      workspaceId: input.workspaceId,
      fingerprint: liveFingerprint,
      status: "failed",
      edgeCount: listProjectModelEdges(input.workspaceId).length,
      detail: error instanceof Error ? error.message : String(error),
      revision,
      ...(git.branch ? { branch: git.branch } : {}),
      ...(git.head ? { head: git.head } : {}),
    });
    emitSetup({
      workspaceId: input.workspaceId,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      snapshot,
    });
    return {
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      snapshot,
      reason: input.reason,
    };
  }
}

function startFlight(input: {
  workspaceId: string;
  cwd: string;
  reason: GroupProjectSetupReason;
  groupId?: string;
  changedPaths?: string[];
}): Promise<GroupProjectSetupOutcome> {
  const existing = flightsByWorkspace.get(input.workspaceId);
  if (existing) return existing.promise;
  const promise = runSetup(input).finally(() => {
    flightsByWorkspace.delete(input.workspaceId);
  });
  flightsByWorkspace.set(input.workspaceId, { promise });
  return promise;
}

/**
 * Schedule non-blocking project Setup for a group Project folder.
 * Coalesces bursts (create / reopen / git / files) via debounce + single-flight.
 * Writes into existing Project Model + CodeGraph — no parallel index.
 */
export function scheduleGroupProjectSetup(input: {
  workspaceId: string;
  reason?: GroupProjectSetupReason;
  cwd?: string;
  groupId?: string;
  changedPaths?: string[];
}): void {
  try {
    const reason = input.reason ?? "manual";
    const workspace = deps.resolveWorkspace(input.workspaceId);
    if (shouldSkipWorkspace(input.workspaceId, workspace)) return;
    const cwd = input.cwd ?? workspace?.rootPath;
    if (!cwd) return;
    registerCwd(input.workspaceId, cwd);

    const prior = pendingByWorkspace.get(input.workspaceId);
    if (prior) clearTimeout(prior.timer);

    const changedPaths = [
      ...new Set([...(prior?.changedPaths ?? []), ...(input.changedPaths ?? [])]),
    ].slice(0, 500);

    const timer = setTimeout(() => {
      pendingByWorkspace.delete(input.workspaceId);
      const groupId = input.groupId ?? prior?.groupId;
      void startFlight({
        workspaceId: input.workspaceId,
        cwd,
        reason,
        ...(groupId ? { groupId } : {}),
        ...(changedPaths.length > 0 ? { changedPaths } : {}),
      });
    }, deps.debounceMs);

    pendingByWorkspace.set(input.workspaceId, {
      timer,
      reason,
      cwd,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(changedPaths.length > 0 ? { changedPaths } : {}),
    });
  } catch {
    // Never surface background Setup failures to IPC/prompt paths.
  }
}

/** Await the in-flight or pending Setup for tests / explicit flush. */
export async function flushGroupProjectSetup(
  workspaceId: string,
): Promise<GroupProjectSetupOutcome | undefined> {
  const pending = pendingByWorkspace.get(workspaceId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingByWorkspace.delete(workspaceId);
    const workspace = deps.resolveWorkspace(workspaceId);
    if (shouldSkipWorkspace(workspaceId, workspace)) return undefined;
    const cwd = pending.cwd ?? workspace?.rootPath;
    if (!cwd) return undefined;
    return startFlight({
      workspaceId,
      cwd,
      reason: pending.reason,
      ...(pending.groupId ? { groupId: pending.groupId } : {}),
      ...(pending.changedPaths ? { changedPaths: pending.changedPaths } : {}),
    });
  }
  const flight = flightsByWorkspace.get(workspaceId);
  if (flight) return flight.promise;
  return undefined;
}

export function isGroupProjectSetupPending(workspaceId: string): boolean {
  return pendingByWorkspace.has(workspaceId) || flightsByWorkspace.has(workspaceId);
}

/**
 * Files-watcher hook: when explorer paths change under a known Project cwd,
 * schedule selective incremental Setup.
 */
export function notifyGroupProjectPathsChanged(cwd: string, paths: string[]): void {
  try {
    const root = resolve(cwd);
    const workspaceId = workspaceByCwd.get(root);
    if (!workspaceId) return;
    scheduleGroupProjectSetup({
      workspaceId,
      reason: "files_change",
      cwd: root,
      changedPaths: paths,
    });
  } catch {
    // Swallow — watcher path must stay quiet.
  }
}

export function getGroupProjectContextSnapshot(
  workspaceId: string,
): GroupProjectContextSnapshot | undefined {
  return getWorkspaceProjectSetup(workspaceId);
}
