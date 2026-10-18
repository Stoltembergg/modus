import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserWindow as BrowserWindowType } from "electron";
import { isUsableModelId } from "../agent/model-service";
import { getAgentRuntime } from "../agent/runtime-registry";
import { getAgent } from "../agents/agents-store";
import { getDatabase } from "../db/database";
import { IPC_CHANNELS } from "../ipc/channels";
import { getWorkspace } from "../workspace/workspace-store";
import { createAutomationService } from "./automation-service";
import { createAutomationStore } from "./automation-store";

let service: ReturnType<typeof createAutomationService> | undefined;

/** Main-process singleton; constructed only after the desktop database is ready. */
export function getAutomationService(): ReturnType<typeof createAutomationService> {
  service ??= createAutomationService({
    store: createAutomationStore(getDatabase()),
    runtime: getAgentRuntime(),
    validateResources(definition) {
      const workspace = getWorkspace(definition.workspaceId);
      let projectDirectory = false;
      if (workspace) {
        try {
          projectDirectory = statSync(workspace.rootPath).isDirectory();
        } catch {
          projectDirectory = false;
        }
      }
      if (
        !workspace ||
        workspace.inbox ||
        resolve(workspace.rootPath) !== resolve(definition.cwd) ||
        !projectDirectory
      ) {
        throw new Error(
          "The selected Project is no longer available. Edit this automation to continue.",
        );
      }
      if (definition.agentId) {
        const agent = getAgent(definition.agentId);
        if (!agent || agent.archivedAt) {
          throw new Error(
            "The selected Agent is no longer available. Edit this automation to continue.",
          );
        }
      }
      if (
        !definition.modelId.startsWith(`${definition.providerId}/`) ||
        !isUsableModelId(definition.modelId)
      ) {
        throw new Error(`The selected model is unavailable: ${definition.modelId}`);
      }
    },
    notify: (window, event) => window.webContents.send(IPC_CHANNELS.automationEvent, event),
  });
  return service;
}

export function startAutomationService(window: BrowserWindowType): void {
  getAutomationService().start(window);
}

export function closeAutomationServiceWindow(): void {
  service?.windowClosed();
}

export function wakeAutomationService(): void {
  service?.wake();
}

export async function stopAutomationService(): Promise<void> {
  await service?.stop();
}
