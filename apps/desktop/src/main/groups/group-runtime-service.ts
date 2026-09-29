import { BrowserWindow } from "electron";
import type { GroupRuntimeEvent, UpdateState } from "../../shared/contracts";
import { getAgentRuntime } from "../agent/runtime-registry";
import { IPC_CHANNELS } from "../ipc/channels";
import { getUpdateService } from "../updater/update-service";
import { GroupRuntime } from "./group-runtime";

/** An update is about to restart the app: new group turns wait until it is gone. */
export function isUpdatePendingState(state: UpdateState): boolean {
  return state.status === "waiting-for-agents" || state.status === "installing";
}

export function emitGroupRuntimeEvent(event: GroupRuntimeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.groupEvent, event);
    }
  }
}

let groupRuntime: GroupRuntime | undefined;

/** The app's single GroupRuntime, bound to the agent runtime's settled turns. */
export function getGroupRuntime(): GroupRuntime {
  if (groupRuntime) return groupRuntime;
  const runtime = getAgentRuntime();
  const instance = new GroupRuntime({
    runtime,
    host: {
      getWindow: () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()),
      isUpdatePending: () => isUpdatePendingState(getUpdateService().getState()),
      emit: emitGroupRuntimeEvent,
    },
  });
  runtime.onTurnSettled((event) => instance.handleTurnSettled(event));
  groupRuntime = instance;
  return instance;
}
