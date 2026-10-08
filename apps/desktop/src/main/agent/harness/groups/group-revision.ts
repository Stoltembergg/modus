import { createHash } from "node:crypto";

export type GroupRevision = {
  groupId: string;
  agentId: string;
  revision: number;
  files: Record<string, string>; // path -> contentHash
  updatedAt: string;
};

/**
 * Computes deterministic SHA-256 hash of file content.
 */
export function computeFileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Detects file conflicts between a base revision and an agent revision.
 * A conflict occurs when a file was modified in both or differs from base.
 */
export function detectConflict(
  baseRevision: GroupRevision,
  agentRevision: GroupRevision,
): string[] {
  const conflicts: string[] = [];
  for (const [path, hash] of Object.entries(agentRevision.files)) {
    const baseHash = baseRevision.files[path];
    if (baseHash !== undefined && baseHash !== hash) {
      conflicts.push(path);
    }
  }
  return conflicts;
}

/**
 * Detects 3-way merge conflicts when two concurrent branches diverge from a common base.
 * Conflict occurs when both current and incoming modified the same file from base into different states.
 */
export function detectThreeWayConflict(
  base: GroupRevision,
  current: GroupRevision,
  incoming: GroupRevision,
): string[] {
  const conflicts: string[] = [];
  const allPaths = new Set([
    ...Object.keys(base.files),
    ...Object.keys(current.files),
    ...Object.keys(incoming.files),
  ]);

  for (const path of allPaths) {
    const baseHash = base.files[path];
    const currentHash = current.files[path];
    const incomingHash = incoming.files[path];

    const currentModified = currentHash !== baseHash;
    const incomingModified = incomingHash !== baseHash;

    if (currentModified && incomingModified && currentHash !== incomingHash) {
      conflicts.push(path);
    }
  }

  return conflicts;
}

/**
 * Advances a group revision if no conflicts exist, merging file maps.
 */
export function advanceRevision(
  base: GroupRevision,
  incoming: GroupRevision,
  newRevisionNumber?: number,
):
  | { success: true; revision: GroupRevision }
  | { success: false; conflicts: string[] } {
  const conflicts = detectConflict(base, incoming);
  if (conflicts.length > 0) {
    return { success: false, conflicts };
  }

  const mergedFiles: Record<string, string> = {
    ...base.files,
    ...incoming.files,
  };

  const nextRevNumber =
    newRevisionNumber ?? Math.max(base.revision, incoming.revision) + 1;

  const revision: GroupRevision = {
    groupId: base.groupId,
    agentId: incoming.agentId,
    revision: nextRevNumber,
    files: mergedFiles,
    updatedAt: new Date().toISOString(),
  };

  return { success: true, revision };
}

/**
 * Creates a new GroupRevision object with defaults.
 */
export function createGroupRevision(params: {
  groupId: string;
  agentId: string;
  revision?: number;
  files?: Record<string, string>;
  updatedAt?: string;
}): GroupRevision {
  return {
    groupId: params.groupId,
    agentId: params.agentId,
    revision: params.revision ?? 1,
    files: { ...(params.files ?? {}) },
    updatedAt: params.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * In-memory registry of latest revisions per group.
 */
export class GroupRevisionRegistry {
  private static instance: GroupRevisionRegistry | null = null;
  private groupRevisions = new Map<string, GroupRevision>();

  public static getInstance(): GroupRevisionRegistry {
    if (!GroupRevisionRegistry.instance) {
      GroupRevisionRegistry.instance = new GroupRevisionRegistry();
    }
    return GroupRevisionRegistry.instance;
  }

  public static resetInstance(): void {
    if (GroupRevisionRegistry.instance) {
      GroupRevisionRegistry.instance.groupRevisions.clear();
      GroupRevisionRegistry.instance = null;
    }
  }

  public getRevision(groupId: string): GroupRevision | undefined {
    return this.groupRevisions.get(groupId);
  }

  public setRevision(groupId: string, revision: GroupRevision): void {
    this.groupRevisions.set(groupId, revision);
  }

  /**
   * Attempts optimistic update. If latest revision in registry has advanced
   * beyond expected base revision and conflicts exist, rejects with conflicts.
   */
  public commitRevision(
    expectedBase: GroupRevision,
    incoming: GroupRevision,
  ):
    | { success: true; revision: GroupRevision }
    | { success: false; conflicts: string[] } {
    const current = this.groupRevisions.get(expectedBase.groupId);

    // Optimistic concurrency gate: the caller's base must still describe the
    // live revision for every file it read. Comparing only `incoming` against
    // `current` let a stale agent commit add-only changes on top of a base it
    // never saw (lost update on deletion/revert detection included).
    if (current) {
      const drifted = Object.entries(expectedBase.files)
        .filter(([path, hash]) => current.files[path] !== hash)
        .map(([path]) => path);
      if (drifted.length > 0) {
        return { success: false, conflicts: drifted };
      }
    }

    const baseToCompare = current ?? expectedBase;

    const result = advanceRevision(baseToCompare, incoming);
    if (result.success) {
      this.groupRevisions.set(expectedBase.groupId, result.revision);
    }
    return result;
  }

  public clear(groupId?: string): void {
    if (groupId) {
      this.groupRevisions.delete(groupId);
    } else {
      this.groupRevisions.clear();
    }
  }
}
