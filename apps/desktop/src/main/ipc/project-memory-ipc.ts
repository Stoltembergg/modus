import type { IpcMain } from "electron";
import { CHATS_WORKSPACE_ID, type ProjectMemorySnapshot } from "../../shared/contracts";
import { getDatabase } from "../db/database";
import { scheduleCodeGraphAutoSync } from "../fast-codebase/codegraph-auto-sync";
import { scheduleGroupProjectSetup } from "../groups/group-project-setup";
import { getWorkspace } from "../workspace/workspace-store";
import { IPC_CHANNELS } from "./channels";
import {
  parseIpcInput,
  projectMemoryIdSchema,
  projectMemorySetEnabledSchema,
  projectMemorySnapshotSchema,
  workspaceSelectSchema,
} from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";
import {
  clearSenderWorkspaceSelection,
  getSelectedWorkspace,
  setSelectedWorkspace,
} from "./workspace-selection";

type MemoryScope = { kind: "global" } | { kind: "project"; workspaceId: string };
type ProjectMemoryService = {
  getProjectMemorySnapshot(workspaceId?: string): ProjectMemorySnapshot;
  setProjectMemoryEnabled(input: { scope: MemoryScope; enabled: boolean }): unknown;
  verifyProjectMemory(memoryId: string): unknown;
  markProjectMemoryObsolete(memoryId: string): unknown;
  deleteProjectMemory(memoryId: string): unknown;
};
type SenderGuard = (event: TrustedSenderEvent) => void;
type IpcHandler = (event: TrustedSenderEvent, input?: unknown) => unknown;
type IpcMainLike = Pick<IpcMain, "handle">;

function getMemoryScope(memoryId: string): MemoryScope | undefined {
  const row = getDatabase()
    .prepare("select scope, workspace_id from project_memory_records where id = ?")
    .get(memoryId) as { scope: string; workspace_id: string | null } | undefined;
  if (!row) return undefined;
  return row.scope === "global"
    ? { kind: "global" }
    : row.workspace_id
      ? { kind: "project", workspaceId: row.workspace_id }
      : undefined;
}

export function registerProjectMemoryIpcHandlers(
  ipcMain: IpcMainLike,
  assertTrustedSender: SenderGuard,
  service: ProjectMemoryService,
  workspaceExists: (workspaceId: string) => boolean = (workspaceId) =>
    Boolean(getWorkspace(workspaceId)),
  resolveMemoryScope: (memoryId: string) => MemoryScope | undefined = getMemoryScope,
): void {
  const register = (channel: string, handler: IpcHandler) =>
    ipcMain.handle(channel, handler as never);
  const destroyListeners = new WeakSet<object>();
  const registerSenderTeardown = (event: TrustedSenderEvent) => {
    const sender = event.sender as
      | (object & { once?: (name: "destroyed", callback: () => void) => void })
      | undefined;
    if (!sender || destroyListeners.has(sender) || !sender.once) return;
    destroyListeners.add(sender);
    sender.once("destroyed", () => clearSenderWorkspaceSelection(sender));
  };
  const requireWorkspace = (workspaceId: string) => {
    if (!workspaceExists(workspaceId)) throw new Error("Workspace not found.");
  };
  const requireCurrentProject = (event: TrustedSenderEvent, workspaceId: string) => {
    if (workspaceId === CHATS_WORKSPACE_ID) {
      throw new Error("Project memory is outside the current workspace scope.");
    }
    requireWorkspace(workspaceId);
    if (!event.sender || getSelectedWorkspace(event.sender) !== workspaceId) {
      throw new Error("Project memory is outside the current workspace scope.");
    }
  };
  const requireMemory = (event: TrustedSenderEvent, memoryId: string): MemoryScope => {
    const scope = resolveMemoryScope(memoryId);
    if (!scope) throw new Error("Project memory not found.");
    if (scope.kind === "project") requireCurrentProject(event, scope.workspaceId);
    return scope;
  };

  register(IPC_CHANNELS.workspaceSelect, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(workspaceSelectSchema, input, IPC_CHANNELS.workspaceSelect);
    const workspaceId = parsed.workspaceId === CHATS_WORKSPACE_ID ? undefined : parsed.workspaceId;
    if (workspaceId) requireWorkspace(workspaceId);
    if (event.sender) {
      registerSenderTeardown(event);
      setSelectedWorkspace(event.sender, workspaceId);
    }
    // Keep CodeGraph binary index warm in the background (non-blocking).
    // Project Model still persists hits when fast_codebase / discoveries produce them.
    if (workspaceId) {
      scheduleCodeGraphAutoSync({ workspaceId, reason: "workspace_select" });
      scheduleGroupProjectSetup({ workspaceId, reason: "reopen" });
    }
  });

  register(IPC_CHANNELS.projectMemorySnapshot, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      projectMemorySnapshotSchema,
      input,
      IPC_CHANNELS.projectMemorySnapshot,
    );
    if (parsed.workspaceId && parsed.workspaceId !== CHATS_WORKSPACE_ID) {
      requireWorkspace(parsed.workspaceId);
      if (!event.sender || getSelectedWorkspace(event.sender) !== parsed.workspaceId) {
        throw new Error("Workspace is outside the current selection.");
      }
    }
    const snapshot = service.getProjectMemorySnapshot(parsed.workspaceId);
    if (parsed.workspaceId !== CHATS_WORKSPACE_ID) return snapshot;
    return {
      ...snapshot,
      projectEnabled: false,
      memories: snapshot.memories.filter((memory) => memory.scope.kind === "global"),
    };
  });

  register(IPC_CHANNELS.projectMemorySetEnabled, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      projectMemorySetEnabledSchema,
      input,
      IPC_CHANNELS.projectMemorySetEnabled,
    );
    if (parsed.scope.kind === "project") {
      if (parsed.scope.workspaceId === CHATS_WORKSPACE_ID) {
        throw new Error("Project memory is unavailable for the Chats inbox.");
      }
      requireCurrentProject(event, parsed.scope.workspaceId);
    }
    return service.setProjectMemoryEnabled(parsed);
  });

  register(IPC_CHANNELS.projectMemoryVerify, (event, input) => {
    assertTrustedSender(event);
    const { memoryId } = parseIpcInput(
      projectMemoryIdSchema,
      input,
      IPC_CHANNELS.projectMemoryVerify,
    );
    requireMemory(event, memoryId);
    return service.verifyProjectMemory(memoryId);
  });

  register(IPC_CHANNELS.projectMemoryMarkObsolete, (event, input) => {
    assertTrustedSender(event);
    const { memoryId } = parseIpcInput(
      projectMemoryIdSchema,
      input,
      IPC_CHANNELS.projectMemoryMarkObsolete,
    );
    requireMemory(event, memoryId);
    return service.markProjectMemoryObsolete(memoryId);
  });

  register(IPC_CHANNELS.projectMemoryDelete, (event, input) => {
    assertTrustedSender(event);
    const { memoryId } = parseIpcInput(
      projectMemoryIdSchema,
      input,
      IPC_CHANNELS.projectMemoryDelete,
    );
    requireMemory(event, memoryId);
    return service.deleteProjectMemory(memoryId);
  });
}
