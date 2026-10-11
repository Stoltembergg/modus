export type GroupTaskDependencies = {
  taskId: string;
  blockedBy: string[]; // taskIds that must complete before this task can start
  writeScopes: string[]; // Paths or subsystem prefixes that this task may modify
};

/**
 * Normalizes a scope path by removing redundant slashes and trailing separators.
 */
export function normalizeScope(scope: string): string {
  return scope.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Checks if two scopes overlap (either identical or one is a subpath/prefix of the other).
 */
export function scopesOverlap(scopeA: string, scopeB: string): boolean {
  const normA = normalizeScope(scopeA);
  const normB = normalizeScope(scopeB);

  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (normA === "*" || normB === "*") return true;

  // Prefix check: e.g. "src/main" and "src/main/agent/tools.ts"
  if (normA.startsWith(normB + "/")) return true;
  if (normB.startsWith(normA + "/")) return true;

  return false;
}

/**
 * Determines if a task can proceed based on whether all its dependencies are satisfied.
 */
export function canProceed(task: GroupTaskDependencies, completedTasks: Set<string>): boolean {
  if (!task.blockedBy || task.blockedBy.length === 0) {
    return true;
  }
  return task.blockedBy.every((dep) => completedTasks.has(dep));
}

/**
 * Detects if two tasks have overlapping write scopes, which would prevent safe concurrent execution.
 */
export function detectWriteConflict(
  task1: GroupTaskDependencies,
  task2: GroupTaskDependencies,
): boolean {
  if (task1.taskId === task2.taskId) return false;

  for (const s1 of task1.writeScopes) {
    for (const s2 of task2.writeScopes) {
      if (scopesOverlap(s1, s2)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Finds all tasks that can be safely scheduled right now:
 * 1. All their dependencies in `blockedBy` are present in `completedTasks`.
 * 2. They do NOT conflict with any currently `runningTasks`.
 * 3. They do NOT conflict with other tasks chosen in this same batch.
 */
export function findEligibleTasks(
  tasks: GroupTaskDependencies[],
  completedTasks: Set<string>,
  runningTasks: GroupTaskDependencies[] = [],
): GroupTaskDependencies[] {
  const eligible: GroupTaskDependencies[] = [];

  for (const task of tasks) {
    // 1. Dependency check
    if (!canProceed(task, completedTasks)) {
      continue;
    }

    // 2. Conflict with running tasks
    const conflictsWithRunning = runningTasks.some((running) => detectWriteConflict(task, running));
    if (conflictsWithRunning) {
      continue;
    }

    // 3. Conflict with tasks already scheduled in this batch
    const conflictsWithBatch = eligible.some((scheduled) => detectWriteConflict(task, scheduled));
    if (conflictsWithBatch) {
      continue;
    }

    eligible.push(task);
  }

  return eligible;
}

/**
 * Detects any dependency cycles among the given tasks.
 * Returns an array of cycles, each cycle being a list of taskIds forming the loop.
 */
export function detectDependencyCycles(tasks: GroupTaskDependencies[]): string[][] {
  const taskMap = new Map<string, GroupTaskDependencies>();
  for (const t of tasks) {
    taskMap.set(t.taskId, t);
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];
  const cycles: string[][] = [];

  function dfs(taskId: string): void {
    visited.add(taskId);
    recursionStack.add(taskId);
    path.push(taskId);

    const task = taskMap.get(taskId);
    if (task) {
      for (const dep of task.blockedBy) {
        if (!taskMap.has(dep)) {
          continue; // External or missing dependency
        }
        if (!visited.has(dep)) {
          dfs(dep);
        } else if (recursionStack.has(dep)) {
          // Found cycle
          const cycleStartIdx = path.indexOf(dep);
          if (cycleStartIdx !== -1) {
            cycles.push([...path.slice(cycleStartIdx), dep]);
          }
        }
      }
    }

    path.pop();
    recursionStack.delete(taskId);
  }

  for (const task of tasks) {
    if (!visited.has(task.taskId)) {
      dfs(task.taskId);
    }
  }

  return cycles;
}
