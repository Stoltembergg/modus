import { type BrowserWindow as BrowserWindowType, Notification } from "electron";
import type { AgentEvent } from "../../shared/contracts";
import { mainText } from "../../shared/main-text";
import { getAgentSession } from "../agent/agent-store";
import { IPC_CHANNELS } from "../ipc/channels";
import { currentUiLocale } from "../locale/ui-language-controller";

/**
 * Background-completion notifications for agent sessions. Notify when a task
 * finishes or needs approval while the app is in the background. Clicking a
 * notification focuses the window and asks the renderer to show that session.
 */

function notify(window: BrowserWindowType, sessionId: string, title: string, body: string): void {
  if (!Notification.isSupported()) {
    return;
  }
  const notification = new Notification({ title, body, silent: false });
  notification.on("click", () => {
    if (window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    window.webContents.send(IPC_CHANNELS.agentFocusSession, sessionId);
  });
  notification.show();
}

/**
 * Fire a system notification for lifecycle events the user should hear about
 * while Modus is not the focused window. Cheap no-op for every other event.
 */
export function maybeNotifyAgentEvent(window: BrowserWindowType, event: AgentEvent): void {
  if (
    event.type !== "run.completed" &&
    event.type !== "run.failed" &&
    event.type !== "permission.requested"
  ) {
    return;
  }
  if (window.isDestroyed() || window.isFocused()) {
    return;
  }

  const locale = currentUiLocale();
  const title =
    getAgentSession(event.sessionId)?.title ?? mainText("main.notification.defaultTitle", locale);
  if (event.type === "run.completed") {
    notify(window, event.sessionId, title, mainText("main.notification.finished", locale));
    return;
  }
  if (event.type === "run.failed") {
    notify(
      window,
      event.sessionId,
      title,
      mainText("main.notification.failed", locale, { message: truncate(event.message, 120) }),
    );
    return;
  }
  notify(
    window,
    event.sessionId,
    title,
    mainText("main.notification.permission", locale, {
      reason: truncate(event.request.reason || event.request.target, 120),
    }),
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
