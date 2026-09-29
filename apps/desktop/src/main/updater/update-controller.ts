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
  /**
   * Whether a handed-off install still completes if the app quits later than expected:
   * the AppImage file is already replaced, and the macOS swap script waits up to 10
   * minutes for the app to exit. Not NSIS: its silent installer gives up right away
   * when it cannot close the app. Decided per platform by `appliesOnQuitFor`.
   */
  appliesOnQuit?: boolean;
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
  /**
   * Only in `waiting-for-agents`: the user chose not to wait for running agents and
   * restarts now. The service itself never interrupts an agent turn.
   */
  restartNow(): Promise<void>;
  /**
   * Shows a failure from the previous run (the mac install script failed after the
   * app quit). Only applies while idle, i.e. right after start.
   */
  reportPreviousFailure(failure: {
    version: string;
    retryable: boolean;
    action: UpdateAction;
  }): void;
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
  /** Set while waiting for agents; ends the wait and installs right away. */
  let forceRestart: (() => Promise<void>) | null = null;
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
    if (
      (state.status === "available" || state.status === "failed") &&
      state.version === candidate.version
    ) {
      if (state.status === "available" && offered?.version !== candidate.version) {
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

  const fail = (error: unknown, stage: string, extra: { appliesOnQuit?: true } = {}) => {
    const failure = describeInstallFailure(error);
    deps.logger.warn(
      `update ${stage} failed: ${errorCode(error) ?? ""} ${errorMessage(error)}`.trim(),
    );
    dispatch({ type: "failed", ...failure, ...extra });
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
    // quit was vetoed), surface a retryable failure instead of "installing" forever. When
    // the installer says the handed-off install still completes on quit, the notice says so.
    deps.timers.setTimeout(() => {
      if (state.status === "installing") {
        fail(
          new Error("the app did not quit to install the update"),
          "install",
          deps.installer.appliesOnQuit ? { appliesOnQuit: true } : {},
        );
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
      let done = false;
      const finish = async () => {
        if (done) return;
        done = true;
        forceRestart = null;
        if (agentPoll !== undefined) deps.timers.clearTimeout(agentPoll);
        agentPoll = undefined;
        try {
          if (state.status === "waiting-for-agents") await installNow(candidate);
        } finally {
          resolve();
        }
      };
      forceRestart = finish;
      const poll = () => {
        agentPoll = deps.timers.setTimeout(() => {
          if (state.status !== "waiting-for-agents" || !deps.agents.hasActiveTurns()) {
            void finish();
            return;
          }
          poll();
        }, agentPollMs);
      };
      poll();
    });
  };

  const restartNow = async () => {
    if (state.status !== "waiting-for-agents" || !forceRestart) return;
    deps.logger.info(`restarting for update ${state.version} without waiting for agents`);
    await forceRestart();
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
    if (state.action === "download-page" || (state.status === "failed" && !state.retryable)) {
      await openReleasePage();
      return;
    }
    if (offered?.version !== state.version) {
      // A failure restored at startup has no release details yet: look them up.
      await checkNow();
      // `state` changes during the await (TS keeps the earlier narrowing).
      const latest = state as UpdateState;
      if (latest.status !== "available" && latest.status !== "failed") return;
      if (latest.action === "download-page") {
        await openReleasePage();
        return;
      }
    }
    const current = state as UpdateState;
    const candidate = offered;
    if (!candidate || !("version" in current) || candidate.version !== current.version || busy) {
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
    restartNow,
    reportPreviousFailure(failure) {
      dispatch({ type: "previous-install-failed", ...failure });
    },
    dismiss() {
      if (state.status !== "available" && state.status !== "failed") return;
      dismissedVersion = state.version;
      deps.logger.info(`update ${state.version} dismissed`);
      dispatch({ type: "dismissed" });
    },
    openReleasePage,
  };
}
