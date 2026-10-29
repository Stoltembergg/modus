import type { BrowserWindow as BrowserWindowType } from "electron";
import type {
  AutomationDefinition,
  AutomationExecution,
  AutomationServiceEvent,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "../../shared/automations";
import type { AgentRuntime, PromptTurnResult } from "../agent/runtime";
import { findMissedAutomationOccurrences, nextAutomationOccurrence } from "./automation-schedule";
import type { createAutomationStore } from "./automation-store";
import { AutomationStoreError } from "./automation-store";

const AUTOMATION_DEADLINE_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

type AutomationStore = ReturnType<typeof createAutomationStore>;
type AutomationTimer = ReturnType<typeof setTimeout>;
type AutomationRuntime = Pick<
  AgentRuntime,
  "create" | "prompt" | "abort" | "dispose" | "listRuns" | "onTurnSettled" | "onQuestionPending"
>;

export type AutomationClock = {
  now(): string;
  setTimeout(callback: () => void, delayMs: number): AutomationTimer;
  clearTimeout(timer: AutomationTimer): void;
};

export class AutomationServiceError extends Error {
  constructor(
    readonly code: "busy" | "window-closed" | "not-found" | "active-execution",
    message: string,
  ) {
    super(message);
    this.name = "AutomationServiceError";
  }
}

type ActiveExecution = {
  executionId: string;
  automationId: string;
  sessionId?: string;
  deadlineTimer: AutomationTimer | undefined;
  cancellationRequested: boolean;
  cancellationReason?: string;
  admission: {
    resolve(execution: AutomationExecution): void;
    reject(error: unknown): void;
    promise: Promise<AutomationExecution>;
  };
  admissionSettled: boolean;
  terminalizing: boolean;
};

export function createAutomationService(input: {
  store: AutomationStore;
  runtime: AutomationRuntime;
  clock?: AutomationClock;
  notify?: (window: BrowserWindowType, event: AutomationServiceEvent) => void;
  validateResources?: (
    selection: Pick<
      AutomationDefinition,
      "workspaceId" | "cwd" | "agentId" | "providerId" | "modelId"
    >,
  ) => void | Promise<void>;
}) {
  const clock = input.clock ?? {
    now: () => new Date().toISOString(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  const listeners = new Set<(event: AutomationServiceEvent) => void>();
  let window: BrowserWindowType | null = null;
  let timer: AutomationTimer | undefined;
  let active: ActiveExecution | null = null;
  let startedOnce = false;
  let stopped = false;

  const publish = (event: AutomationServiceEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn("[modus] automation listener failed:", error);
      }
    }
    if (window && !window.isDestroyed()) {
      try {
        input.notify?.(window, event);
      } catch {
        // Delivery is best effort; a renderer closing must not affect runtime lifecycle.
      }
    }
  };

  const publishExecution = (execution: AutomationExecution): void => {
    publish({ type: "execution-changed", execution });
  };

  const clearTimer = (): void => {
    if (timer) clock.clearTimeout(timer);
    timer = undefined;
  };

  const clearDeadline = (run: ActiveExecution): void => {
    if (run.deadlineTimer) clock.clearTimeout(run.deadlineTimer);
    run.deadlineTimer = undefined;
  };

  const settleAdmission = (
    run: ActiveExecution,
    execution?: AutomationExecution,
    error?: unknown,
  ) => {
    if (run.admissionSettled) return;
    run.admissionSettled = true;
    if (error !== undefined) run.admission.reject(error);
    else if (execution) run.admission.resolve(execution);
  };

  const releaseActive = (run: ActiveExecution): void => {
    clearDeadline(run);
    if (active === run) active = null;
    if (stopped) {
      removeRuntimeListeners();
    } else if (window) {
      scheduleNext();
    }
  };

  const terminalStatus = (result: PromptTurnResult, run: ActiveExecution) => {
    if (run.cancellationRequested || result.outcome === "aborted") {
      return { status: "cancelled" as const, error: run.cancellationReason };
    }
    if (result.outcome === "ok") return { status: "completed" as const };
    if (result.outcome === "blocked") {
      return {
        status: "failed" as const,
        error: "The automation stopped while waiting for confirmation.",
      };
    }
    return { status: "failed" as const, error: result.error ?? "The automation run failed." };
  };

  const finalize = async (run: ActiveExecution, result: PromptTurnResult): Promise<void> => {
    if (run.terminalizing || active !== run) return;
    run.terminalizing = true;
    clearDeadline(run);
    try {
      const terminal = terminalStatus(result, run);
      const execution = input.store.setExecutionStatus(run.executionId, terminal.status, {
        ...(terminal.error ? { error: terminal.error } : {}),
        at: clock.now(),
      });
      publishExecution(execution);
      releaseActive(run);
      if (run.sessionId) {
        void Promise.resolve()
          .then(() => input.runtime.listRuns(run.sessionId as string))
          .then((runs) => {
            const runId = runs.at(-1)?.id;
            if (runId) input.store.attachRun(run.executionId, runId);
          })
          .catch(() => undefined);
      }
    } catch (error) {
      // A persistence failure cannot free the global slot: unresolved external effects remain ambiguous.
      run.terminalizing = false;
      try {
        const execution = input.store.setExecutionStatus(run.executionId, "cleanup_failed", {
          error: `Unable to persist the settled automation result: ${errorMessage(error)}`,
          at: clock.now(),
        });
        publishExecution(execution);
      } catch {
        // Keep the in-memory slot occupied until process recovery can reconcile the record.
      }
    }
  };

  let removeRuntimeListeners = (): void => undefined;
  const unsubscribeSettled = input.runtime.onTurnSettled((event) => {
    if (!active || active.sessionId !== event.sessionId) return;
    void finalize(active, event.result);
  });
  const unsubscribeQuestion = input.runtime.onQuestionPending((sessionId) => {
    if (!active || active.sessionId !== sessionId || active.terminalizing) return;
    try {
      const execution = input.store.setExecutionStatus(active.executionId, "waiting_for_you", {
        at: clock.now(),
      });
      publishExecution(execution);
    } catch {
      // A terminal runtime event may race the question notification; ignore stale progress.
    }
  });
  removeRuntimeListeners = () => {
    unsubscribeSettled();
    unsubscribeQuestion();
  };

  const failBeforePrompt = async (run: ActiveExecution, error: unknown): Promise<void> => {
    if (active !== run || run.terminalizing) return;
    run.terminalizing = true;
    clearDeadline(run);
    let message = error instanceof Error ? error.message : String(error);
    let status: "failed" | "cancelled" = run.cancellationRequested ? "cancelled" : "failed";
    if (run.sessionId) {
      try {
        await input.runtime.dispose(run.sessionId);
      } catch (cleanupError) {
        status = "failed";
        message = `Session cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
        try {
          const execution = input.store.setExecutionStatus(run.executionId, "cleanup_failed", {
            error: message,
            at: clock.now(),
          });
          publishExecution(execution);
        } catch {
          // Keep the in-memory global slot occupied when cleanup cannot be confirmed.
        }
        run.terminalizing = false;
        return;
      }
    }
    try {
      const execution = input.store.setExecutionStatus(run.executionId, status, {
        ...(status === "failed" ? { error: message } : {}),
        at: clock.now(),
      });
      publishExecution(execution);
      settleAdmission(run, undefined, error);
      releaseActive(run);
    } catch (persistError) {
      run.terminalizing = false;
      settleAdmission(run, undefined, error);
      try {
        const execution = input.store.setExecutionStatus(run.executionId, "cleanup_failed", {
          error: `Unable to persist the automation failure: ${errorMessage(persistError)}`,
          at: clock.now(),
        });
        publishExecution(execution);
      } catch {
        // Keep the slot occupied until process recovery can reconcile the unresolved record.
      }
    }
  };

  const requestCancellation = (run: ActiveExecution, reason: string): void => {
    if (active !== run || run.cancellationRequested || run.terminalizing) return;
    run.cancellationRequested = true;
    run.cancellationReason = reason;
    clearDeadline(run);
    try {
      const execution = input.store.setExecutionStatus(run.executionId, "cancelling", {
        error: reason,
        at: clock.now(),
      });
      publishExecution(execution);
    } catch {
      // A settlement may have won the race. The runtime event will release the slot.
    }
    if (!run.sessionId) return;
    let abortPromise: Promise<unknown>;
    try {
      abortPromise = input.runtime.abort(run.sessionId);
    } catch (error) {
      abortPromise = Promise.reject(error);
    }
    void abortPromise.catch((error: unknown) => {
      if (active !== run) return;
      try {
        const execution = input.store.setExecutionStatus(run.executionId, "cleanup_failed", {
          error: error instanceof Error ? error.message : "Unable to stop the automation session.",
          at: clock.now(),
        });
        publishExecution(execution);
      } catch {
        // Keep the slot occupied; subsequent automation admission must fail closed.
      }
    });
  };

  const createAdmission = (): ActiveExecution["admission"] => {
    let resolve!: (execution: AutomationExecution) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<AutomationExecution>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { resolve, reject, promise };
  };

  const startClaimedExecution = (
    execution: AutomationExecution,
    definition: AutomationDefinition,
  ) => {
    const currentWindow = window;
    if (!currentWindow || currentWindow.isDestroyed() || stopped) {
      const failed = input.store.setExecutionStatus(execution.id, "cancelled", {
        error: "Modus is not open.",
        at: clock.now(),
      });
      publishExecution(failed);
      return Promise.reject(
        new AutomationServiceError("window-closed", "Open Modus to run an automation."),
      );
    }
    const run: ActiveExecution = {
      executionId: execution.id,
      automationId: definition.id,
      deadlineTimer: undefined,
      cancellationRequested: false,
      admission: createAdmission(),
      admissionSettled: false,
      terminalizing: false,
    };
    active = run;
    run.deadlineTimer = clock.setTimeout(() => {
      requestCancellation(run, "Automation reached its ten-minute deadline.");
    }, AUTOMATION_DEADLINE_MS);

    void (async () => {
      try {
        const latest = input.store.getDefinition(definition.id);
        if (!latest?.enabled || latest.revision !== definition.revision) {
          throw new AutomationServiceError("not-found", "This automation is no longer available.");
        }
        await input.validateResources?.(latest);
        if (run.cancellationRequested || !window || currentWindow.isDestroyed() || stopped) {
          throw new AutomationServiceError(
            "window-closed",
            run.cancellationReason ?? "Modus window closed before the run could start.",
          );
        }
        const session = await input.runtime.create(currentWindow, {
          workspaceId: execution.config.workspaceId,
          cwd: execution.config.cwd,
          title: execution.config.name,
          model: execution.config.modelId,
          ...(execution.config.agentId ? { agentId: execution.config.agentId } : {}),
        });
        run.sessionId = session.id;
        const attached = input.store.attachSession(run.executionId, session.id, clock.now());
        publishExecution(attached);
        settleAdmission(run, attached);

        const beforePrompt = input.store.getDefinition(definition.id);
        if (!beforePrompt?.enabled || beforePrompt.revision !== execution.automationRevision) {
          throw new AutomationServiceError(
            "not-found",
            "This automation changed before it could start.",
          );
        }
        await input.validateResources?.(beforePrompt);
        if (run.cancellationRequested || !window || currentWindow.isDestroyed() || stopped) {
          if (!run.cancellationRequested)
            requestCancellation(run, "Modus window closed before the run started.");
          try {
            await input.runtime.dispose(session.id);
            const cancelled = input.store.setExecutionStatus(run.executionId, "cancelled", {
              ...(run.cancellationReason ? { error: run.cancellationReason } : {}),
              at: clock.now(),
            });
            publishExecution(cancelled);
            releaseActive(run);
          } catch (error) {
            const cleanupError = input.store.setExecutionStatus(run.executionId, "cleanup_failed", {
              error:
                error instanceof Error
                  ? error.message
                  : "Unable to clean up the automation session.",
              at: clock.now(),
            });
            publishExecution(cleanupError);
            run.terminalizing = false;
          }
          return;
        }

        const promptPromise = input.runtime.prompt(currentWindow, {
          sessionId: session.id,
          message: execution.config.instruction,
          context: [],
          model: execution.config.modelId,
          thinkingLevel: execution.config.thinkingLevel,
          ...(execution.config.thinkingVariant
            ? { thinkingVariant: execution.config.thinkingVariant }
            : {}),
          mode: "build",
        });
        void promptPromise.then(
          (result) => void finalize(run, result),
          (error: unknown) => void finalize(run, { outcome: "failed", error: errorMessage(error) }),
        );
      } catch (error) {
        await failBeforePrompt(run, error);
      }
    })();
    return run.admission.promise;
  };

  const recordMissedIntervals = (): void => {
    const now = clock.now();
    for (const definition of input.store.listDefinitions()) {
      if (!definition.enabled || !definition.nextOccurrenceAt) continue;
      const firstMs = Date.parse(definition.nextOccurrenceAt);
      if (firstMs > Date.parse(now)) continue;
      const missed = findMissedAutomationOccurrences(
        definition.schedule,
        definition.timeZone,
        new Date(firstMs - 1).toISOString(),
        now,
      );
      if (!missed.first || !missed.last || missed.count === 0) continue;
      const execution = input.store.recordMissedInterval({
        automationId: definition.id,
        expectedRevision: definition.revision,
        first: missed.first,
        last: missed.last,
        count: missed.count,
        nextOccurrenceAt: missed.nextOccurrence,
        through: now,
      });
      if (execution) publishExecution(execution);
    }
  };

  const scheduleNext = (): void => {
    clearTimer();
    if (!window || stopped || window.isDestroyed()) return;
    let next: string | undefined;
    try {
      next = input.store
        .listDefinitions()
        .filter((definition) => definition.enabled && definition.nextOccurrenceAt)
        .map((definition) => definition.nextOccurrenceAt as string)
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    } catch {
      console.warn("[modus] automation scheduler paused because persisted data could not be read.");
      return;
    }
    if (!next) return;
    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, Date.parse(next) - Date.parse(clock.now())));
    timer = clock.setTimeout(() => {
      timer = undefined;
      void processDue()
        .catch(() => {
          console.warn("[modus] automation scheduler tick failed; no run was admitted.");
        })
        .finally(scheduleNext);
    }, delay);
  };

  const processDue = async (): Promise<void> => {
    if (!window || stopped || window.isDestroyed()) return;
    const now = clock.now();
    for (const definition of input.store.listDefinitions()) {
      let current = definition;
      let occurrenceCount = 0;
      while (
        current.enabled &&
        current.nextOccurrenceAt &&
        Date.parse(current.nextOccurrenceAt) <= Date.parse(now)
      ) {
        occurrenceCount += 1;
        const scheduledFor = current.nextOccurrenceAt;
        const nextOccurrenceAt = nextAutomationOccurrence(
          current.schedule,
          current.timeZone,
          scheduledFor,
        );
        const claimed = input.store.claimOccurrence({
          automationId: current.id,
          expectedRevision: current.revision,
          triggerKey: `scheduled:${current.id}:${scheduledFor}`,
          triggerKind: "scheduled",
          scheduledFor,
          nextOccurrenceAt,
          occurredAt: now,
        });
        if (claimed.execution) publishExecution(claimed.execution);
        if (claimed.kind === "claimed" && claimed.execution) {
          void startClaimedExecution(claimed.execution, current).catch((error: unknown) => {
            if (!(error instanceof AutomationServiceError)) {
              console.warn("[modus] automation run failed before admission:", error);
            }
          });
        }
        current = input.store.getDefinition(current.id) ?? current;
        if (occurrenceCount >= 500) {
          recordMissedIntervals();
          break;
        }
      }
    }
  };

  return {
    start(nextWindow: BrowserWindowType): void {
      if (stopped || nextWindow.isDestroyed()) return;
      window = nextWindow;
      if (!startedOnce) {
        try {
          for (const execution of input.store.listUnresolvedExecutions()) {
            try {
              const interrupted = input.store.setExecutionStatus(execution.id, "interrupted", {
                error: "Modus closed before this automation was confirmed complete.",
                at: clock.now(),
              });
              publishExecution(interrupted);
            } catch {
              // A duplicate runtime callback or already-reconciled record is harmless.
            }
          }
          startedOnce = true;
        } catch {
          clearTimer();
          console.warn(
            "[modus] automation scheduler paused because prior runs could not be reconciled.",
          );
          return;
        }
      }
      try {
        recordMissedIntervals();
        scheduleNext();
      } catch {
        clearTimer();
        console.warn(
          "[modus] automation scheduler paused because persisted data could not be reconciled.",
        );
      }
    },

    windowClosed(): void {
      window = null;
      clearTimer();
      if (active) requestCancellation(active, "Modus window closed; automation cancelled.");
    },

    wake(): void {
      if (!window || stopped || window.isDestroyed()) return;
      try {
        recordMissedIntervals();
        scheduleNext();
      } catch {
        clearTimer();
        console.warn(
          "[modus] automation scheduler paused because persisted data could not be reconciled.",
        );
      }
    },

    async runNow(id: string): Promise<AutomationExecution> {
      if (active)
        throw new AutomationServiceError("busy", "Another automation is already running.");
      if (!window || window.isDestroyed() || stopped) {
        throw new AutomationServiceError("window-closed", "Open Modus to run an automation.");
      }
      const definition = input.store.getDefinition(id);
      if (!definition) throw new AutomationServiceError("not-found", "Automation not found.");
      const result = input.store.claimOccurrence({
        automationId: definition.id,
        expectedRevision: definition.revision,
        triggerKey: `manual:${definition.id}:${crypto.randomUUID()}`,
        triggerKind: "manual",
        scheduledFor: null,
        occurredAt: clock.now(),
      });
      if (result.kind === "busy")
        throw new AutomationServiceError("busy", "Another automation is already running.");
      if (result.kind !== "claimed" || !result.execution) {
        throw new AutomationServiceError("not-found", "This automation is unavailable.");
      }
      publishExecution(result.execution);
      return startClaimedExecution(result.execution, definition);
    },

    stopCurrent(): void {
      if (active) requestCancellation(active, "Automation stopped by the user.");
    },

    stopExecution(executionId: string): void {
      if (!active || active.executionId !== executionId) {
        throw new AutomationServiceError("not-found", "This automation run is not active.");
      }
      requestCancellation(active, "Automation stopped by the user.");
    },

    async stop(): Promise<void> {
      stopped = true;
      window = null;
      clearTimer();
      if (active) requestCancellation(active, "Modus is shutting down; automation cancelled.");
      else removeRuntimeListeners();
    },

    listDefinitions: () => input.store.listDefinitions(),
    getDefinition: (id: string) => input.store.getDefinition(id),
    listHistory: (id: string, limit?: number) => input.store.listHistory(id, limit),
    async createDefinition(inputDefinition: CreateAutomationInput) {
      await input.validateResources?.(inputDefinition);
      const definition = input.store.createDefinition(inputDefinition);
      publish({ type: "definitions-changed" });
      scheduleNext();
      return definition;
    },
    async updateDefinition(id: string, revision: number, patch: UpdateAutomationInput) {
      const current = input.store.getDefinition(id);
      if (!current) throw new AutomationServiceError("not-found", "Automation not found.");
      const selection = { ...current, ...patch };
      await input.validateResources?.(selection);
      const definition = input.store.updateDefinition(id, revision, patch);
      publish({ type: "definitions-changed" });
      scheduleNext();
      return definition;
    },
    setEnabled(id: string, enabled: boolean) {
      const definition = input.store.setEnabled(id, enabled);
      publish({ type: "definitions-changed" });
      scheduleNext();
      return definition;
    },
    deleteDefinition(id: string): void {
      try {
        input.store.softDeleteDefinition(id, clock.now());
      } catch (error) {
        if (error instanceof AutomationStoreError && error.code === "active-execution") {
          throw new AutomationServiceError("active-execution", error.message);
        }
        throw error;
      }
      publish({ type: "definitions-changed" });
      scheduleNext();
    },
    onChange(listener: (event: AutomationServiceEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
