import { createHash, randomBytes } from "node:crypto";
import { antigravityModels } from "./antigravity-models";

export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const LOAD_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const SCOPES = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email"];

export interface AntigravityCallbackServer {
  waitForCallback(signal: AbortSignal): Promise<URL>;
  close(): Promise<void> | void;
}

export interface AntigravityOAuthDependencies {
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  createLoopbackCallbackServer: (options: { redirectUri: string; signal: AbortSignal }) => Promise<AntigravityCallbackServer> | AntigravityCallbackServer;
  openBrowser: (url: string) => Promise<void> | void;
  createRandom?: (size: number) => Uint8Array;
  timeoutMs?: number;
}

export type AntigravityOAuthStatus =
  | { status: "disconnected" }
  | { status: "connected"; projectId: string }
  | { status: "missing-project"; projectId: null };

export class AntigravityOAuthError extends Error {
  constructor(message: string, readonly code?: string, readonly permanent = false) {
    super(message);
    this.name = "AntigravityOAuthError";
  }
}

const activeProviders = new Set<() => Promise<void>>();

export async function shutdownAntigravityAuth(): Promise<void> {
  await Promise.all([...activeProviders].map((shutdown) => shutdown()));
  activeProviders.clear();
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function oauthError(payload: unknown, status: number): AntigravityOAuthError {
  const error = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : "";
  if (error === "invalid_grant") return new AntigravityOAuthError("Antigravity credentials were revoked", error, true);
  return new AntigravityOAuthError(`Antigravity OAuth request failed (${status})`, error || undefined, false);
}

export function createAntigravityOAuthProvider(deps: AntigravityOAuthDependencies) {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const makeRandom = deps.createRandom ?? ((size: number) => randomBytes(size));
  const timeoutMs = deps.timeoutMs ?? 120_000;
  let credentials: TokenSet | null = null;
  let projectId: string | null = null;
  let generation = 0;
  let activeController: AbortController | null = null;
  let activeServer: AntigravityCallbackServer | null = null;
  const closedServers = new WeakSet<AntigravityCallbackServer>();

  async function closeServer(server: AntigravityCallbackServer | null): Promise<void> {
    if (!server || closedServers.has(server)) return;
    closedServers.add(server);
    await server.close();
  }

  const getStatus = (): AntigravityOAuthStatus => {
    if (!credentials) return { status: "disconnected" };
    return projectId ? { status: "connected", projectId } : { status: "missing-project", projectId: null };
  };

  async function readJson(response: Response): Promise<Record<string, unknown>> {
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) throw oauthError(payload, response.status);
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  }

  async function exchange(form: URLSearchParams, signal?: AbortSignal): Promise<TokenSet> {
    const response = await fetcher(TOKEN_ENDPOINT, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal,
    });
    const payload = await readJson(response);
    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : credentials?.refreshToken ?? "";
    if (!accessToken || !refreshToken) throw new AntigravityOAuthError("Antigravity token response was incomplete");
    return { accessToken, refreshToken, expiresAt: now() + Number(payload.expires_in ?? 3600) * 1000 };
  }

  async function discoverProject(token: string, signal?: AbortSignal): Promise<string | null> {
    const response = await fetcher(LOAD_CODE_ASSIST_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ cloudProject: null, metadata: { ideType: "ANTIGRAVITY" } }),
      signal,
    });
    const payload = await readJson(response);
    const candidate = payload.cloudaicompanionProject;
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (candidate && typeof candidate === "object" && "id" in candidate && typeof candidate.id === "string" && candidate.id.trim()) return candidate.id;
    return null;
  }

  async function connect(): Promise<AntigravityOAuthStatus> {
    await cancel();
    const operationGeneration = ++generation;
    credentials = null;
    projectId = null;
    const controller = new AbortController();
    activeController = controller;
    const state = base64Url(makeRandom(32));
    const verifier = base64Url(makeRandom(32));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let server: AntigravityCallbackServer | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      server = await deps.createLoopbackCallbackServer({ redirectUri: ANTIGRAVITY_REDIRECT_URI, signal: controller.signal });
      activeServer = server;
      if (controller.signal.aborted) throw new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled");
      const authUrl = new URL(AUTHORIZE_ENDPOINT);
      authUrl.search = new URLSearchParams({
        client_id: deps.clientId,
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        response_type: "code",
        scope: SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      await deps.openBrowser(authUrl.toString());
      const callback = await Promise.race([
        server.waitForCallback(controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AntigravityOAuthError("Antigravity OAuth timed out", "timeout")); }, timeoutMs); }),
      ]);
      if (callback.origin !== "http://localhost:51121" || callback.pathname !== "/oauth-callback") throw new AntigravityOAuthError("Unexpected OAuth callback URL");
      if (callback.searchParams.get("error")) throw new AntigravityOAuthError("Antigravity authorization was denied", callback.searchParams.get("error") ?? undefined);
      if (callback.searchParams.get("state") !== state) throw new AntigravityOAuthError("Antigravity OAuth state mismatch", "state_mismatch");
      const code = callback.searchParams.get("code");
      if (!code) throw new AntigravityOAuthError("Antigravity callback did not include an authorization code");
      const tokens = await exchange(new URLSearchParams({
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      }), controller.signal);
      if (generation !== operationGeneration) throw new AntigravityOAuthError("Antigravity credentials changed during authorization");
      credentials = tokens;
      projectId = await discoverProject(tokens.accessToken, controller.signal);
      if (generation !== operationGeneration) throw new AntigravityOAuthError("Antigravity credentials changed during authorization");
      return getStatus();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (activeController === controller) activeController = null;
      if (activeServer === server) activeServer = null;
      await closeServer(server);
    }
  }

  async function refresh(): Promise<AntigravityOAuthStatus> {
    if (!credentials) throw new AntigravityOAuthError("Antigravity is not connected");
    const operationGeneration = generation;
    const previous = credentials;
    const tokens = await exchange(new URLSearchParams({
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
      refresh_token: previous.refreshToken,
      grant_type: "refresh_token",
    }));
    if (generation !== operationGeneration || credentials !== previous) throw new AntigravityOAuthError("Antigravity credentials changed during refresh");
    credentials = tokens;
    return getStatus();
  }

  async function cancel(): Promise<void> {
    activeController?.abort();
    const server = activeServer;
    activeServer = null;
    await closeServer(server);
  }

  async function disconnect(): Promise<void> {
    generation += 1;
    await cancel();
    credentials = null;
    projectId = null;
  }

  const shutdown = async () => {
    await disconnect();
    activeProviders.delete(shutdown);
  };
  activeProviders.add(shutdown);

  return {
    connect,
    refresh,
    cancel,
    disconnect,
    shutdown,
    getStatus,
    getCredentials: () => credentials ? { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt, projectId } : null,
    getMissingProjectModelIds: () => projectId ? [] : antigravityModels
      .filter((model) => model.quotaRoute === "gemini-cli")
      .map(({ id }) => id),
    getAvailableModels: () => antigravityModels.filter((model) => model.quotaRoute === "gemini-cli"),
  };
}
