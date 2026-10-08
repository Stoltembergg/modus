import { getFeatureFlags } from "../feature-flags";
import type {
  HarnessContext,
  HarnessHook,
  HarnessPhase,
  HookExecutionRecord,
} from "./harness-hooks";

/**
 * Core HarnessKernel:
 * Manages the registration, dependency graph resolution, priority sorting,
 * resilient execution, and SLO telemetry for all harness hooks.
 */
export class HarnessKernel {
  private hooks: Map<HarnessPhase, HarnessHook<any, any>[]> = new Map();
  private executionHistory: HookExecutionRecord[] = [];

  constructor() {
    // Initialize phase buckets
    const phases: HarnessPhase[] = [
      "turn_start",
      "context_resolve",
      "prompt_build",
      "model_select",
      "tools_register",
      "verification_check",
      "turn_settle",
      "compact_prune",
    ];
    for (const phase of phases) {
      this.hooks.set(phase, []);
    }
  }

  /**
   * Registers a hook in its respective lifecycle phase.
   */
  registerHook(hook: HarnessHook<any, any>): void {
    const list = this.hooks.get(hook.phase);
    if (!list) {
      throw new Error(`Unknown harness phase: ${hook.phase}`);
    }
    // Prevent duplicate registrations
    const existingIndex = list.findIndex((h) => h.name === hook.name);
    if (existingIndex >= 0) {
      list[existingIndex] = hook;
    } else {
      list.push(hook);
    }
  }

  /**
   * Returns all hooks registered for a given phase in topologically sorted order.
   */
  getHooksForPhase(phase: HarnessPhase): HarnessHook<any, any>[] {
    const list = this.hooks.get(phase) || [];
    return this.resolveHookOrder(list, phase);
  }

  /**
   * Executes all hooks registered for a given phase sequentially in priority and dependency order.
   * If a non-critical hook throws, it logs a warning and proceeds with the current input data (fail-open).
   * If a critical hook throws, it aborts the phase execution.
   */
  async executePhase<TInput = any, TOutput = any>(
    phase: HarnessPhase,
    initialInput: TInput,
    context: HarnessContext,
  ): Promise<TOutput> {
    const flags = getFeatureFlags();
    if (!flags.MODUS_USE_KERNEL) {
      return initialInput as unknown as TOutput;
    }

    const hooks = this.getHooksForPhase(phase);
    console.info(`[modus-harness] Phase: ${phase}, hooks: ${hooks.length}`);

    let currentData: any = initialInput;

    for (const hook of hooks) {
      const startTime = performance.now();
      let success = true;
      let errorMsg: string | undefined = undefined;

      try {
        currentData = await hook.execute(currentData, context);
      } catch (err: any) {
        success = false;
        errorMsg = err?.message || String(err);

        if (hook.isCritical) {
          this.recordExecution(hook.name, phase, startTime, false, errorMsg);
          throw new Error(`Critical harness hook ${hook.name} failed: ${errorMsg}`);
        } else {
          // Graceful fallback: log and continue with previous data
          console.warn(
            `Non-critical hook ${hook.name} failed in phase ${phase}: ${errorMsg}. Continuing.`,
          );
        }
      } finally {
        this.recordExecution(hook.name, phase, startTime, success, errorMsg);
      }
    }

    return currentData as TOutput;
  }

  /**
   * Alias for executePhase to maintain dual-path compatibility.
   */
  async executeHooks<TInput = any, TOutput = any>(
    phase: HarnessPhase,
    initialInput: TInput,
    context: HarnessContext,
  ): Promise<TOutput> {
    return this.executePhase<TInput, TOutput>(phase, initialInput, context);
  }

  /**
   * Topologically sorts hooks based on priority and dependsOn relations.
   */
  private resolveHookOrder(
    hooks: HarnessHook<any, any>[],
    phase?: HarnessPhase,
  ): HarnessHook<any, any>[] {
    if (hooks.length === 0) return hooks;

    // Build map for quick lookup
    const hookMap = new Map<string, HarnessHook<any, any>>();
    for (const h of hooks) {
      hookMap.set(h.name, h);
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const sorted: HarnessHook<any, any>[] = [];

    // Helper for DFS topological sort
    const visit = (hook: HarnessHook<any, any>) => {
      if (visited.has(hook.name)) return;
      if (visiting.has(hook.name)) {
        console.error(
          `Circular dependency detected in phase "${phase ?? hook.phase}". Skipping hook "${hook.name}"`,
        );
        return;
      }

      visiting.add(hook.name);

      if (hook.dependsOn && hook.dependsOn.length > 0) {
        for (const depName of hook.dependsOn) {
          const depHook = hookMap.get(depName);
          if (depHook) {
            visit(depHook);
          } else {
            console.warn(
              `Hook "${hook.name}" in phase "${phase ?? hook.phase}" depends on missing hook: ${depName}. Skipping dependency.`,
            );
          }
        }
      }

      visiting.delete(hook.name);
      visited.add(hook.name);
      sorted.push(hook);
    };

    // Sort initially by ascending priority number (lower number = higher execution priority)
    const prioritySorted = [...hooks].sort((a, b) => a.priority - b.priority);

    for (const hook of prioritySorted) {
      if (!visited.has(hook.name)) {
        visit(hook);
      }
    }

    return sorted;
  }

  /**
   * Returns a copy of the execution records for telemetry and observability.
   */
  getExecutionHistory(): readonly HookExecutionRecord[] {
    return [...this.executionHistory];
  }

  /**
   * Alias for getExecutionHistory for metrics collection.
   */
  getExecutionMetrics(): HookExecutionRecord[] {
    return [...this.executionHistory];
  }

  /**
   * Clears the execution records.
   */
  clearExecutionHistory(): void {
    this.executionHistory = [];
  }

  private recordExecution(
    hookName: string,
    phase: HarnessPhase,
    startTime: number,
    success: boolean,
    error?: string,
  ): void {
    const durationMs = performance.now() - startTime;
    this.executionHistory.push({
      hookName,
      phase,
      durationMs,
      success,
      ...(error ? { error } : {}),
    });
    // Bound the history: long-lived sessions would otherwise grow it without limit.
    if (this.executionHistory.length > 2000) {
      this.executionHistory.shift();
    }
  }
}

let defaultKernelInstance: HarnessKernel | null = null;

export function getGlobalHarnessKernel(): HarnessKernel {
  if (!defaultKernelInstance) {
    defaultKernelInstance = new HarnessKernel();
  }
  return defaultKernelInstance;
}

export function resetGlobalHarnessKernel(): void {
  defaultKernelInstance = null;
}
