import { app, safeStorage, shell } from "electron";
import type { ComposioSettingsState } from "../../shared/contracts";
import { registerComposioMcpSession, unregisterComposioMcpSession } from "../mcp/mcp-service";
import { createComposioApi } from "./composio-api";
import { createComposioProfileStore } from "./composio-profile-store";
import { createComposioSecretStore } from "./composio-secret-store";
import { type ComposioService, createComposioService } from "./composio-service";

let service: ComposioService | undefined;

/** Lazily create the single main-process owner of the local Composio profile. */
export function getComposioService(): ComposioService {
  if (service) return service;
  service = createComposioService({
    secretStore: createComposioSecretStore({
      userDataPath: app.getPath("userData"),
      safeStorage,
    }),
    profileStore: createComposioProfileStore({ userDataPath: app.getPath("userData") }),
    createComposioApi,
    openExternal: (url) => shell.openExternal(url),
    mcp: { registerComposioMcpSession, unregisterComposioMcpSession },
  });
  return service;
}

export async function initializeComposioService(): Promise<ComposioSettingsState> {
  return await getComposioService().initialize();
}

export async function shutdownComposioService(): Promise<void> {
  if (service) await service.shutdown();
}
