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
  /** Invalidates late work when a newer auth attempt, cancellation, sign-out, or shutdown wins. */
  let generation = 0;
  let activeOAuthAttempt: number | undefined;
  let persistenceQueue: Promise<void> = Promise.resolve();
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

  function serializePersistence(work: () => Promise<void>): Promise<void> {
    const next = persistenceQueue.then(work, work);
    persistenceQueue = next.catch(() => undefined);
    return next;
  }

  async function persist(session: AuthBackendSession, run = generation): Promise<void> {
    if (run !== generation) return;
    await serializePersistence(async () => {
      if (run !== generation || session.refreshToken === persistedRefreshToken) return;
      const previousRefreshToken = persistedRefreshToken;
      try {
        const saved = await store.save(session.refreshToken);
        if (run === generation) {
          persistedRefreshToken = saved ? session.refreshToken : undefined;
          return;
        }
      } catch {
        if (run === generation) {
          // Encryption failed: stay signed in for this run, never fall back to plaintext.
          persistedRefreshToken = undefined;
          await store.clear().catch(() => undefined);
          return;
        }
      }

      // A cancellation or newer auth attempt won while the write was in flight. Restore the
      // token that was current before this write; the serialized queue lets newer writes follow.
      if (previousRefreshToken) await store.save(previousRefreshToken);
      else await store.clear();
    });
  }

  async function adoptSession(session: AuthBackendSession, run = generation): Promise<AuthState> {
    if (run !== generation) return snapshot();
    await persist(session, run);
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
    await serializePersistence(() => store.clear());
  }

  function beginAuthAttempt(): number {
    generation += 1;
    if (activeOAuthAttempt !== undefined) {
      activeOAuthAttempt = undefined;
      flows.cancel();
      void closeListener();
    }
    return generation;
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

  async function guarded(run: () => Promise<AuthState>, attempt?: number): Promise<AuthState> {
    try {
      return await run();
    } catch (error) {
      if (attempt !== undefined && attempt !== generation) return snapshot();
      return setState({
        status: state.user ? "signed-in" : "signed-out",
        pendingProvider: null,
        error: userFacingError(error),
      });
    }
  }

  return {
    async initialize() {
      const run = generation;
      persistence = await store.persistence().catch(() => "memory-only" as const);
      if (run !== generation) return snapshot();
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
      if (run !== generation) return snapshot();
      if (!refreshToken) return setState({ status: "signed-out" });
      try {
        persistedRefreshToken = refreshToken;
        const restored = await backend.restore(refreshToken);
        if (run !== generation) return snapshot();
        return await adoptSession(restored, run);
      } catch (error) {
        if (run !== generation) return snapshot();
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
      const attempt = beginAuthAttempt();
      return guarded(async () => {
        const result = await requireBackend().signUp(input.email, input.password);
        if (attempt !== generation) return snapshot();
        if (result.session) return await adoptSession(result.session, attempt);
        return setState({ status: "signed-out", notice: "confirm-email", error: null });
      }, attempt);
    },

    signInWithPassword(input) {
      const attempt = beginAuthAttempt();
      return guarded(async () => {
        const session = await requireBackend().signInWithPassword(input.email, input.password);
        if (attempt !== generation) return snapshot();
        return await adoptSession(session, attempt);
      }, attempt);
    },

    signInWithOAuth(provider) {
      const attempt = beginAuthAttempt();
      activeOAuthAttempt = attempt;
      return guarded(async () => {
        const auth = requireBackend();
        if (!isAuthOAuthProviderId(provider) || !config?.oauthProviders.includes(provider)) {
          throw new Error("This sign-in provider is not enabled.");
        }
        if (state.status === "signed-in") throw new Error("Already signed in.");
        await closeListener();
        if (attempt !== generation) return snapshot();
        const flow = flows.begin(provider);
        let channel: OAuthCallbackChannel | undefined;
        try {
          if (config?.oauthTransport === "deep-link") {
            if (!deps.startDeepLinkCallback) throw new Error("Deep-link sign-in is unavailable.");
            channel = await deps.startDeepLinkCallback({ timeoutMs: oauthTimeoutMs });
          } else {
            channel = loopbackChannel(await deps.startLoopback({ timeoutMs: oauthTimeoutMs }));
          }
          if (attempt !== generation) return snapshot();
          listener = channel;
          const redirectTo = channel.redirectTo(flow.state);
          const authorizeUrl = await auth.createOAuthUrl(provider, redirectTo);
          if (attempt !== generation) return snapshot();
          setState({
            status: "awaiting-oauth",
            pendingProvider: provider,
            notice: null,
            error: null,
          });
          await deps.openExternal(authorizeUrl);
          if (attempt !== generation) return snapshot();
          let params: URLSearchParams;
          try {
            ({ params } = await channel.callback);
          } catch {
            // cancelOAuth()/signOut() already reset the state; anything else is the timeout.
            if (attempt !== generation || listener !== channel) return snapshot();
            throw new AuthBackendError("rejected", "The sign-in timed out. Try again.");
          }
          if (attempt !== generation) return snapshot();
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
          const session = await auth.exchangeCode(code);
          if (attempt !== generation) return snapshot();
          return await adoptSession(session, attempt);
        } finally {
          if (activeOAuthAttempt === attempt) {
            activeOAuthAttempt = undefined;
            flows.cancel();
          }
          if (listener === channel) listener = undefined;
          await channel?.close();
        }
      }, attempt).finally(() => {
        if (activeOAuthAttempt === attempt) {
          activeOAuthAttempt = undefined;
          flows.cancel();
        }
      });
    },

    cancelOAuth() {
      if (activeOAuthAttempt !== undefined) {
        generation += 1;
        activeOAuthAttempt = undefined;
        flows.cancel();
      }
      void closeListener();
      if (state.status !== "awaiting-oauth") return snapshot();
      return setState({ status: "signed-out", pendingProvider: null });
    },

    async signOut() {
      lostByBackend = false;
      generation += 1;
      activeOAuthAttempt = undefined;
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
      generation += 1;
      activeOAuthAttempt = undefined;
      flows.cancel();
      await closeListener();
      unsubscribeBackend?.();
      unsubscribeBackend = undefined;
      backend?.dispose();
      listeners.clear();
    },
  };
}
