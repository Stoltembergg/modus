import {
  type AuthCredentialsInput,
  type AuthOAuthProviderId,
  type AuthPersistence,
  type AuthState,
  type AuthUserProfile,
  isAuthOAuthProviderId,
} from "../../shared/auth";
import { type AuthBackend, AuthBackendError, type AuthBackendSession } from "./auth-backend";
import type { AuthConfig } from "./auth-config";
import type { AuthSessionStore } from "./auth-session-store";
import type { LoopbackListener } from "./loopback-server";
import { loopbackChannel, type OAuthCallbackChannel } from "./oauth-callback";
import { OAUTH_FLOW_TIMEOUT_MS, type OAuthFlowRegistry } from "./oauth-flow";

export interface AuthService {
  initialize(): Promise<AuthState>;
  getState(): AuthState;
  signUp(input: AuthCredentialsInput): Promise<AuthState>;
  signInWithPassword(input: AuthCredentialsInput): Promise<AuthState>;
  /** Opens the browser and resolves when the callback (loopback or deep link) was handled. */
  signInWithOAuth(provider: AuthOAuthProviderId): Promise<AuthState>;
  cancelOAuth(): AuthState;
  signOut(): Promise<AuthState>;
  /**
   * B4b, main process only (never on IPC): the current access token, null unless signed in.
   * The Modus router adapter reads it per request.
   */
  getAccessToken(): Promise<string | null>;
  /**
   * Single-flight: concurrent callers share one in-flight refresh. With `rejected` (the token
   * that just got a 401), a token that already moved on is returned without refreshing again.
   * Throws AuthBackendError ("network" keeps the session, anything else means it is dead).
   */
  refreshAccessToken(rejected?: string): Promise<string>;
  /**
   * The router session cannot be recovered (refresh rejected, or a 401 after the retry): sign
   * the account out locally with the "session-expired" notice. Provider keys (BYOK) are not
   * touched: they live in pi's auth.json, never here.
   */
  expireSession(): Promise<AuthState>;
  onStateChange(listener: (state: AuthState) => void): () => void;
  shutdown(): Promise<void>;
}

type Deps = {
  config: AuthConfig | undefined;
  backend: AuthBackend | undefined;
  store: AuthSessionStore;
  flows: OAuthFlowRegistry;
  startLoopback(options: { timeoutMs: number }): Promise<LoopbackListener>;
  /** modus://auth/callback transport (config.oauthTransport === "deep-link"). */
  startDeepLinkCallback?(options: { timeoutMs: number }): Promise<OAuthCallbackChannel>;
  openExternal(url: string): Promise<void>;
  oauthTimeoutMs?: number;
};

const MAX_ERROR_LENGTH = 200;
const GENERIC_ERROR = "Something went wrong. Try again.";
const NETWORK_ERROR = "Couldn't reach the account service. Check your connection and try again.";

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function httpsOrNull(value: unknown): string | null {
  const raw = stringOrNull(value);
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** Errors shown to the user: backend rejections keep their (short) message, the rest are generic. */
export function userFacingError(error: unknown): string {
  if (error instanceof AuthBackendError) {
    if (error.kind === "network") return NETWORK_ERROR;
    if (error.kind === "rejected" && error.message) {
      return error.message.slice(0, MAX_ERROR_LENGTH);
    }
  }
  return GENERIC_ERROR;
}

export function createAuthService(deps: Deps): AuthService {
  const { config, backend, store, flows } = deps;
  const oauthTimeoutMs = deps.oauthTimeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
  const listeners = new Set<(state: AuthState) => void>();
  let persistence: AuthPersistence = "memory-only";
  let state: AuthState = {
    status: backend && config ? "restoring" : "unconfigured",
    user: null,
    persistence,
    oauthProviders: config?.oauthProviders ?? [],
    pendingProvider: null,
    notice: null,
    error: null,
  };
  let listener: OAuthCallbackChannel | undefined;
  let persistedRefreshToken: string | undefined;
  let unsubscribeBackend: (() => void) | undefined;
  /** Bumped on sign-out so a late profile fetch cannot resurrect a signed-out user. */
  let generation = 0;
  let refreshing: Promise<string> | undefined;
  /** The backend dropped the session (supabase-js SIGNED_OUT) and nothing replaced it yet. */
  let lostByBackend = false;

  function snapshot(): AuthState {
    return {
      ...state,
      oauthProviders: [...state.oauthProviders],
      user: state.user && { ...state.user },
    };
  }

  function setState(patch: Partial<AuthState>): AuthState {
    state = { ...state, ...patch, persistence };
    const next = snapshot();
    for (const notify of listeners) notify(snapshot());
    return next;
  }

  function profileFrom(session: AuthBackendSession): AuthUserProfile {
    const { user } = session;
    return {
      id: user.id,
      email: user.email,
      displayName:
        stringOrNull(user.metadata.full_name) ?? stringOrNull(user.metadata.name) ?? null,
      avatarUrl: httpsOrNull(user.metadata.avatar_url),
      emailConfirmed: Boolean(user.emailConfirmedAt),
      provider: user.provider || "email",
    };
  }

  async function persist(session: AuthBackendSession): Promise<void> {
    if (session.refreshToken === persistedRefreshToken) return;
    try {
      const saved = await store.save(session.refreshToken);
      persistedRefreshToken = saved ? session.refreshToken : undefined;
    } catch {
      // Encryption failed: stay signed in for this run, never fall back to plaintext.
      persistedRefreshToken = undefined;
      await store.clear().catch(() => undefined);
    }
  }

  async function adoptSession(session: AuthBackendSession): Promise<AuthState> {
    const run = generation;
    await persist(session);
    if (run !== generation) return snapshot();
    const user = profileFrom(session);
    lostByBackend = false;
    setState({ status: "signed-in", user, pendingProvider: null, notice: null, error: null });
    try {
      const profile = await backend?.fetchProfile(user.id);
      if (profile && run === generation && state.user?.id === user.id) {
        setState({
          user: {
            ...user,
            displayName: stringOrNull(profile.displayName) ?? user.displayName,
            avatarUrl: httpsOrNull(profile.avatarUrl) ?? user.avatarUrl,
          },
        });
      }
    } catch {
      // The profile row is optional for display; the session is still valid.
    }
    return snapshot();
  }

  async function clearLocalSession(): Promise<void> {
    generation += 1;
    persistedRefreshToken = undefined;
    await store.clear();
  }

  function requireBackend(): AuthBackend {
    if (!backend || !config) throw new Error("Account sign-in is not configured in this build.");
    return backend;
  }

  async function closeListener(): Promise<void> {
    const current = listener;
    listener = undefined;
    await current?.close();
  }

  async function guarded(run: () => Promise<AuthState>): Promise<AuthState> {
    try {
      return await run();
    } catch (error) {
      return setState({
        status: state.user ? "signed-in" : "signed-out",
        pendingProvider: null,
        error: userFacingError(error),
      });
    }
  }

  return {
    async initialize() {
      persistence = await store.persistence().catch(() => "memory-only" as const);
      if (!backend || !config) return setState({ status: "unconfigured" });
      unsubscribeBackend ??= backend.onSessionChange((session) => {
        if (session) {
          // Refreshed tokens rotate: keep the stored refresh token current.
          if (state.status === "signed-in") void persist(session);
          return;
        }
        if (state.status === "signed-in") {
          lostByBackend = true;
          void clearLocalSession().then(() => setState({ status: "signed-out", user: null }));
        }
      });
      setState({ status: "restoring" });
      const refreshToken = await store.load().catch(() => undefined);
      if (!refreshToken) return setState({ status: "signed-out" });
      try {
        persistedRefreshToken = refreshToken;
        return await adoptSession(await backend.restore(refreshToken));
      } catch (error) {
        if (error instanceof AuthBackendError && error.kind === "network") {
          // Keep the stored token: the next start may be online.
          return setState({ status: "signed-out", error: NETWORK_ERROR });
        }
        await clearLocalSession();
        return setState({ status: "signed-out", error: null });
      }
    },

    getState: snapshot,

    signUp(input) {
      return guarded(async () => {
        const result = await requireBackend().signUp(input.email, input.password);
        if (result.session) return await adoptSession(result.session);
        return setState({ status: "signed-out", notice: "confirm-email", error: null });
      });
    },

    signInWithPassword(input) {
      return guarded(async () => {
        const session = await requireBackend().signInWithPassword(input.email, input.password);
        return await adoptSession(session);
      });
    },

    signInWithOAuth(provider) {
      return guarded(async () => {
        const auth = requireBackend();
        if (!isAuthOAuthProviderId(provider) || !config?.oauthProviders.includes(provider)) {
          throw new Error("This sign-in provider is not enabled.");
        }
        if (state.status === "signed-in") throw new Error("Already signed in.");
        await closeListener();
        const flow = flows.begin(provider);
        let channel: OAuthCallbackChannel;
        if (config?.oauthTransport === "deep-link") {
          if (!deps.startDeepLinkCallback) throw new Error("Deep-link sign-in is unavailable.");
          channel = await deps.startDeepLinkCallback({ timeoutMs: oauthTimeoutMs });
        } else {
          channel = loopbackChannel(await deps.startLoopback({ timeoutMs: oauthTimeoutMs }));
        }
        listener = channel;
        try {
          const redirectTo = channel.redirectTo(flow.state);
          const authorizeUrl = await auth.createOAuthUrl(provider, redirectTo);
          setState({
            status: "awaiting-oauth",
            pendingProvider: provider,
            notice: null,
            error: null,
          });
          await deps.openExternal(authorizeUrl);
          let params: URLSearchParams;
          try {
            ({ params } = await channel.callback);
          } catch {
            // cancelOAuth()/signOut() already reset the state; anything else is the timeout.
            if (listener !== channel) return snapshot();
            throw new AuthBackendError("rejected", "The sign-in timed out. Try again.");
          }
          const verdict = flows.consume(params.get("state"));
          if (!verdict.ok) {
            throw new AuthBackendError(
              "rejected",
              "The sign-in response was not accepted. Try again.",
            );
          }
          if (params.get("error")) {
            throw new AuthBackendError("rejected", "Sign-in was cancelled or denied.");
          }
          const code = params.get("code");
          if (!code) throw new AuthBackendError("rejected", "The sign-in response was incomplete.");
          return await adoptSession(await auth.exchangeCode(code));
        } finally {
          flows.cancel();
          if (listener === channel) listener = undefined;
          await channel.close();
        }
      });
    },

    cancelOAuth() {
      flows.cancel();
      void closeListener();
      if (state.status !== "awaiting-oauth") return snapshot();
      return setState({ status: "signed-out", pendingProvider: null });
    },

    async signOut() {
      lostByBackend = false;
      flows.cancel();
      await closeListener();
      // Local state is cleared even if the server call fails (offline, revoked token).
      await clearLocalSession();
      try {
        await backend?.signOut();
      } catch {
        // ignore: nothing secret is left locally
      }
      return setState({
        status: backend ? "signed-out" : "unconfigured",
        user: null,
        notice: null,
        error: null,
        pendingProvider: null,
      });
    },

    async getAccessToken() {
      if (!backend || !config || state.status !== "signed-in") return null;
      return await backend.getAccessToken();
    },

    async refreshAccessToken(rejected) {
      if (refreshing) return await refreshing;
      const auth = requireBackend();
      if (state.status !== "signed-in") throw new AuthBackendError("rejected", "signed out");
      if (rejected) {
        const current = await auth.getAccessToken().catch(() => null);
        if (refreshing) return await refreshing;
        if (current && current !== rejected) return current;
      }
      const run = auth.refreshAccessToken();
      refreshing = run;
      try {
        return await run;
      } finally {
        if (refreshing === run) refreshing = undefined;
      }
    },

    async expireSession() {
      if (state.status !== "signed-in" && !lostByBackend) return snapshot();
      lostByBackend = false;
      await clearLocalSession();
      try {
        await backend?.signOut();
      } catch {
        // ignore: the refresh token is already dead or cleared locally
      }
      return setState({
        status: "signed-out",
        user: null,
        notice: "session-expired",
        error: null,
        pendingProvider: null,
      });
    },

    onStateChange(listenerFn) {
      listeners.add(listenerFn);
      return () => listeners.delete(listenerFn);
    },

    async shutdown() {
      flows.cancel();
      await closeListener();
      unsubscribeBackend?.();
      unsubscribeBackend = undefined;
      backend?.dispose();
      listeners.clear();
    },
  };
}
