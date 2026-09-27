import type { UpdateAction, UpdateState } from "../../shared/contracts";
import { describeInstallFailure, errorCode, errorMessage } from "./update-errors";
import { isNewerStableVersion, releasePageUrl, type UpdateFile } from "./update-policy";
import { createUpdateScheduler, type UpdateTimers } from "./update-scheduler";
import { IDLE, isCheckAllowed, reduceUpdateState, type UpdateEvent } from "./update-state-machine";

export type UpdateCandidate = {
  version: string;
  files: UpdateFile[];
};

/** Where updates come from (electron-updater in production, a fake in tests). */
export type UpdateSource = {
  /** Latest stable release newer than the running app, or null when up to date. */
  check(): Promise<UpdateCandidate | null>;
};

/** Platform-specific download + install-and-restart. */
export type PlatformInstaller = {
  /** Whether this candidate can be installed in place or only offered as a download page. */
  actionFor(candidate: UpdateCandidate): Promise<UpdateAction>;
  /** Downloads and verifies the update; `onProgress` receives 0..100. */
  download(candidate: UpdateCandidate, onProgress: (percent: number) => void): Promise<void>;
  /** Installs the downloaded update and quits/restarts the app. */
  install(candidate: UpdateCandidate): Promise<void>;
};

export type AgentActivityProbe = {
  hasActiveTurns(): boolean;
};

export type UpdateLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};

export type UpdateController = {
  start(): void;
  stop(): void;
  getState(): UpdateState;
  subscribe(listener: (state: UpdateState) => void): () => void;
  /** One background check (errors stay silent). Exposed for tests and the scheduler. */
  checkNow(): Promise<void>;
  install(): Promise<void>;
  retry(): Promise<void>;
  dismiss(): void;
  openReleasePage(): Promise<void>;
};

export type UpdateControllerDeps = {
  currentVersion: string;
  source: UpdateSource;
  installer: PlatformInstaller;
  agents: AgentActivityProbe;
  timers: UpdateTimers;
  logger: UpdateLogger;
  now: () => number;
  openExternal: (url: string) => Promise<void>;
  /** Runs right before the app quits to install (PR 4 saves UI state here). */
  beforeInstallRestart: () => Promise<void> | void;
  initialDelayMs?: number;
  intervalMs?: number;
  /** How often to re-check agent activity while the restart is deferred. */
  agentPollMs?: number;
  /** Minimum gap between info-level logs of background check failures. */
  failureLogIntervalMs?: number;
  /** If the app is still running this long after install(), report a failure. */
  installWatchdogMs?: number;
};

export const AGENT_POLL_MS = 2_000;
export const FAILURE_LOG_INTERVAL_MS = 60 * 60_000;
export const INSTALL_WATCHDOG_MS = 60_000;

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const agentPollMs = deps.agentPollMs ?? AGENT_POLL_MS;
  const failureLogIntervalMs = deps.failureLogIntervalMs ?? FAILURE_LOG_INTERVAL_MS;
  const installWatchdogMs = deps.installWatchdogMs ?? INSTALL_WATCHDOG_MS;
  const listeners = new Set<(state: UpdateState) => void>();
  let state: UpdateState = IDLE;
  let offered: UpdateCandidate | null = null;
  let dismissedVersion: string | null = null;
  let checkInFlight: Promise<void> | null = null;
  let busy = false;
  let agentPoll: unknown;
  let lastFailureLogAt: number | null = null;
  let suppressedFailures = 0;

  const dispatch = (event: UpdateEvent) => {
    const next = reduceUpdateState(state, event);
    if (next === state) return;
    state = next;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // A broken subscriber must not break the updater.
      }
    }
  };

  const logBackgroundFailure = (error: unknown) => {
    const detail = `${errorCode(error) ?? "error"}: ${errorMessage(error).split("\n")[0]}`;
    const at = deps.now();
    // Until the first release exists every check fails (no releases / 404). Keep that
    // out of error logs: info at most once per interval, debug otherwise.
    if (lastFailureLogAt === null || at - lastFailureLogAt >= failureLogIntervalMs) {
      const suppressed = suppressedFailures
        ? ` (${suppressedFailures} similar since last log)`
        : "";
      deps.logger.info(`background update check failed${suppressed}: ${detail}`);
      lastFailureLogAt = at;
      suppressedFailures = 0;
    } else {
      suppressedFailures += 1;
      deps.logger.debug(`background update check failed: ${detail}`);
    }
  };

  const runCheck = async () => {
    const candidate = await deps.source.check();
    if (!candidate || !isNewerStableVersion(candidate.version, deps.currentVersion)) {
      deps.logger.debug("no newer stable release");
      dispatch({ type: "check-settled" });
      return;
    }
    if (candidate.version === dismissedVersion) {
      deps.logger.debug(`update ${candidate.version} was dismissed`);
      dispatch({ type: "check-settled" });
      return;
    }
    const action = await deps.installer.actionFor(candidate);
    dispatch({ type: "check-found", version: candidate.version, action });
    if (state.status === "available" && state.version === candidate.version) {
      if (offered?.version !== candidate.version) {
        deps.logger.info(`update ${candidate.version} available (action: ${action})`);
      }
      offered = candidate;
    }
  };

  const checkNow = async () => {
    if (checkInFlight) return checkInFlight;
    if (busy || !isCheckAllowed(state)) return;
    dispatch({ type: "check-started" });
    checkInFlight = runCheck()
      .catch((error: unknown) => {
        logBackgroundFailure(error);
        dispatch({ type: "check-settled" });
      })
      .finally(() => {
        checkInFlight = null;
      });
    return checkInFlight;
  };

  const scheduler = createUpdateScheduler({
    timers: deps.timers,
    tick: checkNow,
    ...(deps.initialDelayMs === undefined ? {} : { initialDelayMs: deps.initialDelayMs }),
    ...(deps.intervalMs === undefined ? {} : { intervalMs: deps.intervalMs }),
  });

  const fail = (error: unknown, stage: string) => {
    const failure = describeInstallFailure(error);
    deps.logger.warn(
      `update ${stage} failed: ${errorCode(error) ?? ""} ${errorMessage(error)}`.trim(),
    );
    dispatch({ type: "failed", ...failure });
  };

  const installNow = async (candidate: UpdateCandidate) => {
    agentPoll = undefined;
    dispatch({ type: "install-started" });
    if (state.status !== "installing") return;
    deps.logger.info(`installing update ${candidate.version} and restarting`);
    try {
      await deps.beforeInstallRestart();
      await deps.installer.install(candidate);
    } catch (error) {
      fail(error, "install");
      return;
    }
    // install() hands off to the quit; if the app is somehow still alive later (e.g. a
    // quit was vetoed), surface a retryable failure instead of "installing" forever.
    deps.timers.setTimeout(() => {
      if (state.status === "installing") {
        fail(new Error("the app did not quit to install the update"), "install");
      }
    }, installWatchdogMs);
  };

  const restartWhenAgentsIdle = async (candidate: UpdateCandidate) => {
    if (!deps.agents.hasActiveTurns()) {
      await installNow(candidate);
      return;
    }
    dispatch({ type: "restart-deferred" });
    deps.logger.info(`update ${candidate.version} ready; restart waits for running agents`);
    await new Promise<void>((resolve) => {
      const poll = () => {
        agentPoll = deps.timers.setTimeout(() => {
          if (state.status !== "waiting-for-agents") return resolve();
          if (deps.agents.hasActiveTurns()) return poll();
          void installNow(candidate).finally(resolve);
        }, agentPollMs);
      };
      poll();
    });
  };

  const openReleasePage = async () => {
    const version = "version" in state ? state.version : offered?.version;
    try {
      await deps.openExternal(releasePageUrl(version));
    } catch (error) {
      deps.logger.warn(`could not open release page: ${errorMessage(error)}`);
    }
  };

  const install = async () => {
    if (busy) return;
    if (state.status !== "available" && state.status !== "failed") return;
    const candidate = offered;
    if (!candidate || candidate.version !== state.version) return;
    if (state.action === "download-page" || (state.status === "failed" && !state.retryable)) {
      await openReleasePage();
      return;
    }
    busy = true;
    try {
      deps.logger.info(`downloading update ${candidate.version}`);
      dispatch({ type: "download-started", version: candidate.version });
      try {
        await deps.installer.download(candidate, (percent) => {
          dispatch({ type: "download-progress", percent });
        });
      } catch (error) {
        fail(error, "download");
        return;
      }
      dispatch({ type: "download-finished" });
      await restartWhenAgentsIdle(candidate);
    } finally {
      busy = false;
    }
  };

  return {
    start: () => scheduler.start(),
    stop: () => {
      scheduler.stop();
      if (agentPoll !== undefined) deps.timers.clearTimeout(agentPoll);
      agentPoll = undefined;
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    checkNow,
    install,
    retry: install,
    dismiss() {
      if (state.status !== "available" && state.status !== "failed") return;
      dismissedVersion = state.version;
      deps.logger.info(`update ${state.version} dismissed`);
      dispatch({ type: "dismissed" });
    },
    openReleasePage,
  };
}
