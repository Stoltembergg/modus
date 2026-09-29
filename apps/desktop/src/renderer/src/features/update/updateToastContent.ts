import type { UpdateState } from "../../../../shared/contracts";

/** Buttons map 1:1 to `window.modus.update` methods. */
export type UpdateToastActionId = "install" | "retry" | "restartNow" | "openReleasePage";

export type UpdateToastAction = { id: UpdateToastActionId; label: string };

export type UpdateToastContent = {
  /** Announced politely; stays stable while a download progresses. */
  title: string;
  detail?: string;
  /** Download percent (0–100) for the progress bar. */
  progress?: number;
  /** Restart in progress: a spinner instead of an icon. */
  busy?: boolean;
  tone: "info" | "danger";
  actions: UpdateToastAction[];
  /** Only offers and failures can be dismissed (the service hides that version). */
  dismissible: boolean;
  /** The primary button gently breathes to draw the eye (only for a new offer). */
  breathe?: boolean;
};

const DOWNLOAD: UpdateToastAction = { id: "openReleasePage", label: "Download" };

/**
 * What the update notice shows for a service state; `null` renders nothing. Checks and
 * their errors are silent, so idle/checking never show a notice.
 */
export function updateToastContent(state: UpdateState): UpdateToastContent | null {
  switch (state.status) {
    case "idle":
    case "checking":
      return null;
    case "available":
      return {
        title: `New version ${state.version} available`,
        tone: "info",
        actions: [state.action === "install" ? { id: "install", label: "Install" } : DOWNLOAD],
        dismissible: true,
        breathe: true,
      };
    case "downloading":
      return {
        title: `Downloading ${state.version}`,
        progress: state.percent,
        tone: "info",
        actions: [],
        dismissible: false,
      };
    case "ready":
    case "installing":
      return {
        title: "Restarting to update…",
        busy: true,
        tone: "info",
        actions: [],
        dismissible: false,
      };
    case "waiting-for-agents":
      // The app never stops a running turn by itself; the user may choose to.
      return {
        title: "Restarts when the agent finishes",
        detail: `Version ${state.version} is ready.`,
        tone: "info",
        actions: [{ id: "restartNow", label: "Restart now" }],
        dismissible: false,
      };
    case "failed": {
      if (state.appliesOnQuit) {
        // Nothing to do but close Modus: the pending install already runs on quit, so
        // no Try again and no Restart now. Only dismiss.
        return {
          title: "The update will be applied when Modus closes",
          detail: `Version ${state.version} is ready.`,
          tone: "info",
          actions: [],
          dismissible: true,
        };
      }
      // The service opens the release page for page failures and non-retryable ones,
      // so offer that directly instead of a "Try again" that would do the same.
      const pageOnly = state.action === "download-page" || !state.retryable;
      const actions = pageOnly ? [DOWNLOAD] : [{ id: "retry" as const, label: "Try again" }];
      return {
        title: `Couldn't update to ${state.version}`,
        ...(pageOnly ? { detail: "Download it from the release page." } : {}),
        tone: "danger",
        actions,
        dismissible: true,
      };
    }
  }
}
