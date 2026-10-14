import type { SecurityState } from "../../../preload/types";
import type {
  AgentInfo,
  AgentSessionInfo,
  ModelSettingsState,
  WorkspaceInfo,
} from "../../../shared/contracts";

export type InitialAppDataSource = {
  app: {
    securityState(): Promise<SecurityState>;
  };
  workspace: {
    list(): Promise<WorkspaceInfo[]>;
  };
  agent: {
    list(): Promise<AgentSessionInfo[]>;
  };
  agents: {
    list(): Promise<AgentInfo[]>;
  };
  model: {
    settings(): Promise<ModelSettingsState>;
  };
};

export type InitialAppHydration = {
  securityState: Promise<SecurityState>;
  workspaces: Promise<WorkspaceInfo[]>;
  sessions: Promise<AgentSessionInfo[]>;
  profiles: Promise<AgentInfo[]>;
  modelSettings: Promise<ModelSettingsState>;
  settled: Promise<void>;
};

/** Starts the independent first-screen reads together without coupling their failures. */
export function beginInitialAppHydration(api: InitialAppDataSource): InitialAppHydration {
  const securityState = api.app.securityState();
  const workspaces = api.workspace.list();
  const sessions = api.agent.list();
  const profiles = api.agents.list();
  const modelSettings = api.model.settings();
  const pending = [securityState, workspaces, sessions, profiles, modelSettings];

  return {
    securityState,
    workspaces,
    sessions,
    profiles,
    modelSettings,
    settled: Promise.allSettled(pending).then(() => undefined),
  };
}
