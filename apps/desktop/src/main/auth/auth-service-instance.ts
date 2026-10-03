import { app, BrowserWindow, safeStorage, shell } from "electron";
import type { AuthState } from "../../shared/auth";
import type { AuthIpcService } from "../ipc/auth-ipc";
import { IPC_CHANNELS } from "../ipc/channels";
import { type AuthConfig, resolveAuthConfig } from "./auth-config";
import { type AuthService, createAuthService } from "./auth-service";
import { createAuthSessionStore } from "./auth-session-store";
import { startLoopbackListener } from "./loopback-server";
import { createDeepLinkCallbackHub } from "./oauth-callback";
import { createOAuthFlowRegistry } from "./oauth-flow";
import { createSupabaseAuthBackend } from "./supabase-auth-backend";

let service: AuthService | undefined;
let backend: ReturnType<typeof createSupabaseAuthBackend> | undefined;

/** modus://auth/callback links are handed here by the deep-link router (main/index.ts). */
export const deepLinkCallbackHub = createDeepLinkCallbackHub();

function loadConfig(): AuthConfig | undefined {
  try {
    return resolveAuthConfig(process.env, import.meta.env as Record<string, string | undefined>);
  } catch (error) {
    console.warn(
      "[auth] Supabase config rejected:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

function broadcast(state: AuthState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.authStateEvent, state);
  }
}

/** Lazily create the single main-process owner of the Supabase session. */
export function getAuthService(): AuthService {
  if (service) return service;
  const config = loadConfig();
  backend = config ? createSupabaseAuthBackend(config) : undefined;
  service = createAuthService({
    config,
    backend,
    store: createAuthSessionStore({ userDataPath: app.getPath("userData"), safeStorage }),
    flows: createOAuthFlowRegistry(),
    startLoopback: startLoopbackListener,
    startDeepLinkCallback: (options) => deepLinkCallbackHub.start(options),
    openExternal: (url) => shell.openExternal(url),
  });
  service.onStateChange(broadcast);
  return service;
}

/** The same Supabase client (and session) backs billing reads and the Stripe Functions. */
export function getSupabaseBillingBackend() {
  getAuthService();
  return backend;
}

/** For IPC registration: the service (and Electron paths) are only touched on first use. */
export const authIpcService: AuthIpcService = {
  getState: () => getAuthService().getState(),
  signUp: (input) => getAuthService().signUp(input),
  signInWithPassword: (input) => getAuthService().signInWithPassword(input),
  signInWithOAuth: (provider) => getAuthService().signInWithOAuth(provider),
  cancelOAuth: () => getAuthService().cancelOAuth(),
  signOut: () => getAuthService().signOut(),
};

export async function initializeAuthService(): Promise<AuthState> {
  return await getAuthService().initialize();
}

export async function shutdownAuthService(): Promise<void> {
  if (service) await service.shutdown();
}
