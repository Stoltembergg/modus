import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "@earendil-works/pi-ai/compat";
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

/** Bind an actual localhost-only callback listener for the fixed OAuth redirect. */
export async function createLoopbackCallbackServer(options: { redirectUri: string; signal: AbortSignal }): Promise<AntigravityCallbackServer> {
  const redirect = new URL(options.redirectUri);
  if (redirect.hostname !== "localhost" || redirect.pathname !== "/oauth-callback") {
    throw new AntigravityOAuthError("Invalid Antigravity loopback redirect");
  }
  let resolveCallback!: (value: URL) => void;
  let rejectCallback!: (reason: unknown) => void;
  let settled = false;
  const callback = new Promise<URL>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // Avoid a transient unhandled rejection when cancellation precedes waitForCallback.
  void callback.catch(() => undefined);
  const servers: Server[] = [];
  const receive = (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
      const url = new URL(request.url ?? "/", options.redirectUri);
      if (request.method !== "GET" || url.pathname !== redirect.pathname) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      response.end("Authorization received. You can close this window.");
      if (!settled) {
        settled = true;
        resolveCallback(url);
      }
    };
  const listenResults = await Promise.allSettled(["127.0.0.1", "::1"].map((host) => new Promise<void>((resolve, reject) => {
    const server = createServer(receive);
    servers.push(server);
    server.once("error", reject);
    server.listen(Number(redirect.port), host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  })));
  const unsupportedFamily = (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
    ["EAFNOSUPPORT", "EADDRNOTAVAIL", "ENODEV"].includes(String(error.code));
  const failure = listenResults.find((result) => result.status === "rejected" && !unsupportedFamily(result.reason));
  const listeningCount = listenResults.filter((result) => result.status === "fulfilled").length;
  if (failure || listeningCount === 0) {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    throw failure?.status === "rejected" ? failure.reason : new AntigravityOAuthError("No loopback callback interface is available");
  }
  let closePromise: Promise<void> | undefined;
   const closeListeners = (): Promise<void> => {
    if (!closePromise) {
      // server.close() alone waits forever for keep-alive/stalled sockets.
      // This API is available on Node's public http.Server surface.
      const closing = servers.map((server) => new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
      }));
      for (const server of servers) server.closeAllConnections();
      closePromise = Promise.all(closing).then(() => undefined);
    }
    return closePromise;
  };
  const closeOnAbort = () => { void closeListeners().catch(() => undefined); };
  options.signal.addEventListener("abort", closeOnAbort, { once: true });
  if (options.signal.aborted) closeOnAbort();
  callback.then(() => { void closeListeners().catch(() => undefined); }, () => undefined);
  return {
    waitForCallback(signal) {
      if (signal.aborted) return Promise.reject(new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled"));
      return new Promise<URL>((resolve, reject) => {
        let done = false;
        const finish = (action: () => void) => {
          if (done) return;
          done = true;
          signal.removeEventListener("abort", onAbort);
          action();
        };
        const onAbort = () => finish(() => reject(new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled")));
        signal.addEventListener("abort", onAbort, { once: true });
        callback.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
      });
    },
    close() {
      options.signal.removeEventListener("abort", closeOnAbort);
      return closeListeners();
    },
  };
}

export interface AntigravityOAuthDependencies {
  clientId: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  createLoopbackCallbackServer?: (options: { redirectUri: string; signal: AbortSignal }) => Promise<AntigravityCallbackServer> | AntigravityCallbackServer;
  openBrowser: (url: string) => Promise<void> | void;
  createRandom?: (size: number) => Uint8Array;
  timeoutMs?: number;
  /** Test override; production shutdown drain remains five seconds. */
  shutdownDrainTimeoutMs?: number;
  removeRejectedCredential?: (credential: OAuthCredentials) => Promise<void>;
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
const SHUTDOWN_REFRESH_DRAIN_MS = 5_000;

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
  const cleanupTasks = new Set<Promise<void>>();
  const refreshTasks = new Set<Promise<OAuthCredentials>>();
  const connectTasks = new Set<Promise<AntigravityOAuthStatus>>();
  let shuttingDown = false;
  let refreshDrainExpired = false;
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

  async function oauthFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetcher(url, init);
    } catch {
      if (init.signal?.aborted) {
        throw new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled");
      }
      throw new AntigravityOAuthError("Antigravity OAuth network request failed");
    }
  }

  async function exchange(form: URLSearchParams, signal?: AbortSignal, fallbackRefreshToken?: string): Promise<TokenSet> {
    const response = await oauthFetch(TOKEN_ENDPOINT, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, ...(signal ? { signal } : {}),
    });
    const payload = await readJson(response);
    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : fallbackRefreshToken ?? credentials?.refreshToken ?? "";
    if (!accessToken || !refreshToken) throw new AntigravityOAuthError("Antigravity token response was incomplete");
    return { accessToken, refreshToken, expiresAt: now() + Number(payload.expires_in ?? 3600) * 1000 };
  }

  async function discoverProject(token: string, signal?: AbortSignal): Promise<string | null> {
    const response = await oauthFetch(LOAD_CODE_ASSIST_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ cloudProject: null, metadata: { ideType: "ANTIGRAVITY" } }),
      ...(signal ? { signal } : {}),
    });
    const payload = await readJson(response);
    const candidate = payload.cloudaicompanionProject;
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (candidate && typeof candidate === "object" && "id" in candidate && typeof candidate.id === "string" && candidate.id.trim()) return candidate.id;
    return null;
  }

  async function connectImpl(onAuth?: (info: { url: string; instructions?: string }) => void, externalSignal?: AbortSignal): Promise<AntigravityOAuthStatus> {
    if (shuttingDown) throw new AntigravityOAuthError("Antigravity authorization is shutting down", "cancelled");
    if (!deps.clientId) {
      throw new AntigravityOAuthError("Antigravity OAuth client configuration is unavailable");
    }
    if (externalSignal?.aborted) throw new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled");
    const previousController = activeController;
    const previousServer = activeServer;
    activeServer = null;
    const operationGeneration = ++generation;
    credentials = null;
    projectId = null;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    activeController = controller;
    const state = base64Url(makeRandom(32));
    const verifier = base64Url(makeRandom(32));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let server: AntigravityCallbackServer | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      previousController?.abort();
      await closeServer(previousServer);
      if (shuttingDown || controller.signal.aborted) throw new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled");
      server = await (deps.createLoopbackCallbackServer ?? createLoopbackCallbackServer)({ redirectUri: ANTIGRAVITY_REDIRECT_URI, signal: controller.signal });
      activeServer = server;
      if (shuttingDown || controller.signal.aborted) throw new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled");
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
      if (onAuth) onAuth({ url: authUrl.toString(), instructions: "Complete sign-in in your browser." });
      else await deps.openBrowser(authUrl.toString());
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
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      }), controller.signal);
      if (controller.signal.aborted) throw new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled");
      if (generation !== operationGeneration) throw new AntigravityOAuthError("Antigravity credentials changed during authorization");
      try {
        projectId = await discoverProject(tokens.accessToken, controller.signal);
      } catch {
        if (controller.signal.aborted) {
          throw new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled");
        }
        // Project discovery is optional for Antigravity's five-model quota pool.
        // A failed discovery is represented as missing-project, not failed OAuth.
        projectId = null;
      }
      if (controller.signal.aborted) throw new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled");
      if (generation !== operationGeneration) throw new AntigravityOAuthError("Antigravity credentials changed during authorization");
      if (controller.signal.aborted) throw new AntigravityOAuthError("Antigravity authorization was cancelled", "cancelled");
      credentials = tokens;
      return getStatus();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (activeController === controller) activeController = null;
      externalSignal?.removeEventListener("abort", onExternalAbort);
      if (activeServer === server) activeServer = null;
      await closeServer(server);
    }
  }

  function connect(onAuth?: (info: { url: string; instructions?: string }) => void, externalSignal?: AbortSignal): Promise<AntigravityOAuthStatus> {
    const task = connectImpl(onAuth, externalSignal);
    connectTasks.add(task);
    void task.finally(() => connectTasks.delete(task)).catch(() => undefined);
    return task;
  }

  async function refreshCurrent(previous: TokenSet, operationGeneration: number): Promise<TokenSet> {
    const tokens = await exchange(new URLSearchParams({
      client_id: deps.clientId,
      refresh_token: previous.refreshToken,
      grant_type: "refresh_token",
    }), undefined, previous.refreshToken);
    if (generation !== operationGeneration || credentials !== previous) throw new AntigravityOAuthError("Antigravity credentials changed during refresh");
    credentials = tokens;
    return tokens;
  }

  async function refresh(): Promise<AntigravityOAuthStatus> {
    if (shuttingDown) throw new AntigravityOAuthError("Antigravity authorization is shutting down", "cancelled");
    if (!credentials) throw new AntigravityOAuthError("Antigravity is not connected");
    const operationGeneration = generation;
    const previous = credentials;
    await refreshCurrent(previous, operationGeneration);
    return getStatus();
  }

  function piCredentials(): OAuthCredentials {
    if (!credentials) throw new AntigravityOAuthError("Antigravity is not connected");
    return { access: credentials.accessToken, refresh: credentials.refreshToken, expires: credentials.expiresAt, ...(projectId ? { projectId } : {}) };
  }

  function scheduleRejectedCredentialCleanup(rejected: OAuthCredentials): void {
    if (!deps.removeRejectedCredential || (shuttingDown && refreshDrainExpired)) return;
    let task!: Promise<void>;
    task = Promise.resolve().then(() => deps.removeRejectedCredential!(rejected)).catch(() => undefined).finally(() => cleanupTasks.delete(task));
    cleanupTasks.add(task);
  }

  function trackRefresh(work: () => Promise<OAuthCredentials>): Promise<OAuthCredentials> {
    let task!: Promise<OAuthCredentials>;
    task = work().finally(() => refreshTasks.delete(task));
    refreshTasks.add(task);
    return task;
  }

  const oauth: Omit<OAuthProviderInterface, "id"> = {
    name: "Antigravity",
    usesCallbackServer: true,
    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      if (shuttingDown) throw new AntigravityOAuthError("Antigravity authorization is shutting down", "cancelled");
      callbacks.signal?.throwIfAborted();
      await connect(callbacks.onAuth, callbacks.signal);
      callbacks.signal?.throwIfAborted();
      return piCredentials();
    },
    async refreshToken(rejected: OAuthCredentials): Promise<OAuthCredentials> {
      if (shuttingDown) throw new AntigravityOAuthError("Antigravity authorization is shutting down", "cancelled");
      return trackRefresh(async () => {
      const generationAtStart = generation;
      const currentAtStart = credentials;
      const supplied: TokenSet = {
        accessToken: rejected.access,
        refreshToken: rejected.refresh,
        expiresAt: rejected.expires,
      };
      const suppliedProjectId = typeof rejected.projectId === "string" ? rejected.projectId : null;
       const suppliedMatchesCurrent = currentAtStart !== null &&
        currentAtStart.accessToken === supplied.accessToken &&
        currentAtStart.refreshToken === supplied.refreshToken &&
         currentAtStart.expiresAt === supplied.expiresAt &&
         projectId === suppliedProjectId;
       if (currentAtStart !== null && !suppliedMatchesCurrent) {
         throw new AntigravityOAuthError("Antigravity credentials changed before refresh", "cancelled");
       }
       try {
        const tokens = await exchange(new URLSearchParams({
          client_id: deps.clientId,
          refresh_token: supplied.refreshToken,
          grant_type: "refresh_token",
        }), undefined, supplied.refreshToken);
        if (generation !== generationAtStart || credentials !== currentAtStart) {
          throw new AntigravityOAuthError("Antigravity credentials changed during refresh", "cancelled");
        }
        if (suppliedMatchesCurrent || currentAtStart === null) {
          credentials = tokens;
          projectId = suppliedProjectId;
        }
        return { access: tokens.accessToken, refresh: tokens.refreshToken, expires: tokens.expiresAt, ...(suppliedProjectId ? { projectId: suppliedProjectId } : {}) };
      } catch (error) {
        if (error instanceof AntigravityOAuthError && error.code === "invalid_grant") {
          scheduleRejectedCredentialCleanup(rejected);
        }
        throw error;
      }
      });
    },
    getApiKey(value: OAuthCredentials): string { return value.access; },
  };

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

  let shutdownTask: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    // Start the one shutdown budget before any teardown work or await.
    const deadline = Date.now() + (deps.shutdownDrainTimeoutMs ?? SHUTDOWN_REFRESH_DRAIN_MS);
    shuttingDown = true;
    generation += 1;
    credentials = null;
    projectId = null;
    activeController?.abort();
    const teardown = cancel();
    shutdownTask = (async () => {
      while (connectTasks.size || refreshTasks.size || cleanupTasks.size || teardown) {
        const pending = [...connectTasks, ...refreshTasks, ...cleanupTasks, teardown];
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        refreshDrainExpired = true;
        break;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      // Attach rejection observers even if the deadline wins; late completions
      // must never become unhandled while shutdown no longer waits for them.
      const settled = Promise.allSettled(pending);
      void settled.then(() => undefined);
      await Promise.race([settled, new Promise<void>((resolve) => { timeout = setTimeout(resolve, remaining); })]);
      if (timeout !== undefined) clearTimeout(timeout);
      // A settled teardown remains in the set expression only until this loop
      // exits; the fixed promise is harmless and all late failures are observed.
      if (Date.now() >= deadline && (connectTasks.size || refreshTasks.size || cleanupTasks.size)) refreshDrainExpired = true;
      if (!connectTasks.size && !refreshTasks.size && !cleanupTasks.size) break;
      }
      activeProviders.delete(shutdown);
    })();
    void shutdownTask.catch(() => undefined);
    return shutdownTask;
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
    oauth,
    getMissingProjectModelIds: () => projectId ? [] : antigravityModels
      .filter((model) => model.quotaRoute === "gemini-cli")
      .map(({ id }) => id),
    getAvailableModels: () => antigravityModels.filter((model) => model.quotaRoute === "antigravity" || projectId !== null),
  };
}
