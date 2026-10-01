import { BrowserWindow } from "electron";
import type { GroupRuntimeEvent } from "../../shared/contracts";
import { getAgentRuntime } from "../agent/runtime-registry";
import { IPC_CHANNELS } from "../ipc/channels";
import { getUpdateService } from "../updater/update-service";
import { GroupRuntime, isUpdatePendingState } from "./group-runtime";

export function emitGroupRuntimeEvent(event: GroupRuntimeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.groupEvent, event);
    }
  }
}

let setupBridgeInstalled = false;

/** Push `group.project-setup` events on the same `group:event` channel as Activity. */
export function ensureGroupProjectSetupBridge(): void {
  if (setupBridgeInstalled) return;
  setupBridgeInstalled = true;
  void import("./group-project-setup").then(({ onGroupProjectSetup }) => {
    onGroupProjectSetup(({ workspaceId, groupId, snapshot }) => {
      emitGroupRuntimeEvent({
        type: "group.project-setup",
        workspaceId,
        ...(groupId ? { groupId } : {}),
        status: snapshot.status,
        fingerprint: snapshot.fingerprint,
        edgeCount: snapshot.edgeCount,
        ...(snapshot.codegraphState ? { codegraphState: snapshot.codegraphState } : {}),
        ...(snapshot.detail ? { detail: snapshot.detail } : {}),
        updatedAt: snapshot.updatedAt,
      });
    });
  });
}

let groupRuntime: GroupRuntime | undefined;

/** The app's single GroupRuntime (it subscribes to the agent runtime itself). */
export function getGroupRuntime(): GroupRuntime {
  ensureGroupProjectSetupBridge();
  if (groupRuntime) return groupRuntime;
  const runtime = getAgentRuntime();
  const instance = new GroupRuntime({
    runtime,
    recoverPending: true,
    host: {
      getWindow: () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()),
      isUpdatePending: () => isUpdatePendingState(getUpdateService().getState()),
      emit: emitGroupRuntimeEvent,
    },
  });
  groupRuntime = instance;
  instance.kick();
  return instance;
}

/** App quit: clears the retry timer and the runtime subscriptions (no-op if never created). */
export function disposeGroupRuntime(): void {
  groupRuntime?.dispose();
  groupRuntime = undefined;
}
