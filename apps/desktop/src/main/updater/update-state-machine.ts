import type { UpdateAction, UpdateState } from "../../shared/contracts";

/**
 * Pure update state machine. Invalid transitions return the current state unchanged,
 * so a late event (e.g. a background check result while downloading) cannot move the
 * machine backwards.
 */
export type UpdateEvent =
  | { type: "check-started" }
  | { type: "check-found"; version: string; action: UpdateAction }
  /** Up to date, dismissed version, or a background check failure (always silent). */
  | { type: "check-settled" }
  | { type: "download-started"; version: string }
  | { type: "download-progress"; percent: number }
  | { type: "download-finished" }
  | { type: "restart-deferred" }
  | { type: "install-started" }
  | { type: "failed"; retryable: boolean; action: UpdateAction }
  | { type: "dismissed" }
  /** Restored at startup from the mac install script's failure marker. */
  | { type: "previous-install-failed"; version: string; retryable: boolean; action: UpdateAction };

export const IDLE: UpdateState = { status: "idle" };

export function reduceUpdateState(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case "check-started":
      // A background re-check while an update is offered keeps the offer visible.
      return state.status === "idle" ? { status: "checking" } : state;
    case "check-found":
      if (state.status === "idle" || state.status === "checking") {
        return { status: "available", version: event.version, action: event.action };
      }
      if (state.status === "available" || state.status === "failed") {
        // Same version: keep the current offer (or the visible failure and its retry).
        if (
          state.version === event.version &&
          (state.status === "failed" || state.action === event.action)
        ) {
          return state;
        }
        return { status: "available", version: event.version, action: event.action };
      }
      return state;
    case "check-settled":
      return state.status === "checking" ? IDLE : state;
    case "download-started":
      return state.status === "available" || state.status === "failed"
        ? { status: "downloading", version: event.version, percent: 0 }
        : state;
    case "download-progress": {
      if (state.status !== "downloading") return state;
      const percent = Math.min(100, Math.max(state.percent, Math.round(event.percent * 10) / 10));
      return percent === state.percent ? state : { ...state, percent };
    }
    case "download-finished":
      return state.status === "downloading" ? { status: "ready", version: state.version } : state;
    case "restart-deferred":
      return state.status === "ready"
        ? { status: "waiting-for-agents", version: state.version }
        : state;
    case "install-started":
      return state.status === "ready" || state.status === "waiting-for-agents"
        ? { status: "installing", version: state.version }
        : state;
    case "failed":
      if (
        state.status === "downloading" ||
        state.status === "ready" ||
        state.status === "waiting-for-agents" ||
        state.status === "installing"
      ) {
        return {
          status: "failed",
          version: state.version,
          retryable: event.retryable,
          action: event.action,
        };
      }
      return state;
    case "previous-install-failed":
      return state.status === "idle" || state.status === "checking"
        ? {
            status: "failed",
            version: event.version,
            retryable: event.retryable,
            action: event.action,
          }
        : state;
    case "dismissed":
      return state.status === "available" || state.status === "failed" ? IDLE : state;
  }
}

/** Checks never overlap and never run once a download started or an install is pending. */
export function isCheckAllowed(state: UpdateState): boolean {
  return state.status === "idle" || state.status === "available" || state.status === "failed";
}

export function stateVersion(state: UpdateState): string | undefined {
  return "version" in state ? state.version : undefined;
}
