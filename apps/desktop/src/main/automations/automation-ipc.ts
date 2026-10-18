import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { UpdateAutomationInput } from "../../shared/automations";
import type { WorkspaceInfo } from "../../shared/contracts";
import { IPC_CHANNELS } from "../ipc/channels";
import {
  automationCreateSchema,
  automationDeleteSchema,
  automationGetSchema,
  automationHistorySchema,
  automationRunNowSchema,
  automationSetEnabledSchema,
  automationStopSchema,
  automationUpdateSchema,
  parseIpcInput,
} from "../ipc/schemas";
import type { createAutomationService } from "./automation-service";

type AutomationService = ReturnType<typeof createAutomationService>;

export function registerAutomationIpcHandlers(input: {
  ipcMain: Pick<IpcMain, "handle">;
  assertTrustedSender(event: IpcMainInvokeEvent): void;
  resolveWorkspace(id: string): WorkspaceInfo | undefined;
  service: AutomationService | (() => AutomationService);
}): void {
  const getService = () => (typeof input.service === "function" ? input.service() : input.service);
  const handle = (
    channel: string,
    operation: (event: IpcMainInvokeEvent, payload?: unknown) => unknown,
  ) =>
    input.ipcMain.handle(channel, async (event, payload) => {
      input.assertTrustedSender(event);
      return await operation(event, payload);
    });

  handle(IPC_CHANNELS.automationList, () => getService().listDefinitions());
  handle(IPC_CHANNELS.automationGet, (_event, payload) => {
    const { id } = parseIpcInput(automationGetSchema, payload, IPC_CHANNELS.automationGet);
    return getService().getDefinition(id);
  });
  handle(IPC_CHANNELS.automationHistory, (_event, payload) => {
    const parsed = parseIpcInput(automationHistorySchema, payload, IPC_CHANNELS.automationHistory);
    return getService().listHistory(parsed.id, parsed.limit);
  });
  handle(IPC_CHANNELS.automationCreate, async (_event, payload) => {
    const parsed = parseIpcInput(automationCreateSchema, payload, IPC_CHANNELS.automationCreate);
    const workspace = requireProject(input.resolveWorkspace(parsed.workspaceId));
    const { thinkingVariant, ...definition } = parsed;
    return getService().createDefinition({
      ...definition,
      ...(thinkingVariant !== undefined ? { thinkingVariant } : {}),
      cwd: workspace.rootPath,
      enabled: true,
    });
  });
  handle(IPC_CHANNELS.automationUpdate, async (_event, payload) => {
    const parsed = parseIpcInput(automationUpdateSchema, payload, IPC_CHANNELS.automationUpdate);
    const patch = Object.fromEntries(
      Object.entries(parsed.patch).filter(([, value]) => value !== undefined),
    ) as UpdateAutomationInput;
    if (patch.workspaceId !== undefined) {
      const workspace = requireProject(input.resolveWorkspace(patch.workspaceId));
      return getService().updateDefinition(parsed.id, parsed.revision, {
        ...patch,
        cwd: workspace.rootPath,
      });
    }
    return getService().updateDefinition(parsed.id, parsed.revision, patch);
  });
  handle(IPC_CHANNELS.automationSetEnabled, (_event, payload) => {
    const parsed = parseIpcInput(
      automationSetEnabledSchema,
      payload,
      IPC_CHANNELS.automationSetEnabled,
    );
    return getService().setEnabled(parsed.id, parsed.enabled);
  });
  handle(IPC_CHANNELS.automationDelete, (_event, payload) => {
    const { id } = parseIpcInput(automationDeleteSchema, payload, IPC_CHANNELS.automationDelete);
    return getService().deleteDefinition(id);
  });
  handle(IPC_CHANNELS.automationRunNow, (_event, payload) => {
    const { id } = parseIpcInput(automationRunNowSchema, payload, IPC_CHANNELS.automationRunNow);
    return getService().runNow(id);
  });
  handle(IPC_CHANNELS.automationStop, (_event, payload) => {
    const { executionId } = parseIpcInput(
      automationStopSchema,
      payload,
      IPC_CHANNELS.automationStop,
    );
    return getService().stopExecution(executionId);
  });
}

function requireProject(workspace: WorkspaceInfo | undefined): WorkspaceInfo {
  if (!workspace || workspace.inbox) {
    throw new Error("Automations require an available Project folder.");
  }
  return workspace;
}
