import {
  type AuthError,
  createClient,
  isAuthApiError,
  isAuthRetryableFetchError,
  isAuthWeakPasswordError,
  type Session,
  type SupportedStorage,
} from "@supabase/supabase-js";
import type { AuthOAuthProviderId } from "../../shared/auth";
import {
  type AuthBackend,
  AuthBackendError,
  type AuthBackendProfile,
  type AuthBackendSession,
} from "./auth-backend";
import type { AuthConfig } from "./auth-config";

/** supabase-js keeps the session and the PKCE code_verifier here: process memory only. */
export function createMemoryAuthStorage(): SupportedStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

function toBackendError(error: unknown): AuthBackendError {
  if (error instanceof AuthBackendError) return error;
  if (isAuthRetryableFetchError(error)) return new AuthBackendError("network", "network");
  if (isAuthWeakPasswordError(error)) {
    return new AuthBackendError("rejected", "Choose a stronger password.");
  }
  if (isAuthApiError(error)) {
    const status = (error as AuthError).status ?? 0;
    if (status >= 500) return new AuthBackendError("other", "server");
    return new AuthBackendError("rejected", (error as AuthError).message);
  }
  return new AuthBackendError("other", "unexpected");
}

function toSession(session: Session | null | undefined): AuthBackendSession {
  if (!session?.access_token || !session.refresh_token || !session.user) {
    throw new AuthBackendError("other", "missing session");
  }
  const { user } = session;
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    user: {
      id: user.id,
      email: user.email ?? null,
      emailConfirmedAt: user.email_confirmed_at ?? null,
      provider:
        typeof user.app_metadata?.provider === "string" ? user.app_metadata.provider : "email",
      metadata: (user.user_metadata ?? {}) as Record<string, unknown>,
    },
  };
}

export function createSupabaseAuthBackend(config: AuthConfig): AuthBackend {
  const client = createClient(config.supabaseUrl, config.anonKey, {
    auth: {
      flowType: "pkce",
      storage: createMemoryAuthStorage(),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  const authorizeOrigin = new URL(config.supabaseUrl).origin;

  async function run<R extends { data: unknown; error: AuthError | null }>(
    operation: () => Promise<R>,
  ): Promise<R["data"]> {
    let result: R;
    try {
      result = await operation();
    } catch (error) {
      throw toBackendError(error);
    }
    if (result.error) throw toBackendError(result.error);
    return result.data;
  }

  async function started(session: Session | null): Promise<AuthBackendSession> {
    const mapped = toSession(session);
    // Outside a browser supabase-js only refreshes in the background once asked to.
    await client.auth.startAutoRefresh();
    return mapped;
  }

  return {
    async signUp(email, password) {
      const data = await run(() => client.auth.signUp({ email, password }));
      return { session: data.session ? await started(data.session) : null };
    },

    async signInWithPassword(email, password) {
      const data = await run(() => client.auth.signInWithPassword({ email, password }));
      return await started(data.session);
    },

    async createOAuthUrl(provider: AuthOAuthProviderId, redirectTo: string) {
      const data = await run(() =>
        client.auth.signInWithOAuth({
          provider,
          options: { redirectTo, skipBrowserRedirect: true },
        }),
      );
      const url = new URL(data.url ?? "");
      if (url.origin !== authorizeOrigin || url.pathname !== "/auth/v1/authorize") {
        throw new AuthBackendError("other", "unexpected authorize url");
      }
      return url.href;
    },

    async exchangeCode(code) {
      const data = await run(() => client.auth.exchangeCodeForSession(code));
      return await started(data.session);
    },

    async restore(refreshToken) {
      const data = await run(() => client.auth.refreshSession({ refresh_token: refreshToken }));
      return await started(data.session);
    },

    async signOut() {
      await client.auth.stopAutoRefresh();
      // "local" revokes this device's refresh token only, not the user's other sessions.
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw toBackendError(error);
    },

    async fetchProfile(userId): Promise<AuthBackendProfile | null> {
      const { data, error } = await client
        .from("profiles")
        .select("display_name, avatar_url")
        .eq("id", userId)
        .maybeSingle();
      if (error || !data) return null;
      const row = data as { display_name: unknown; avatar_url: unknown };
      return {
        displayName: typeof row.display_name === "string" ? row.display_name : null,
        avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
      };
    },

    onSessionChange(listener) {
      const { data } = client.auth.onAuthStateChange((event, session) => {
        // Never call supabase-js from inside this callback (it holds the auth lock).
        setTimeout(() => {
          if (event === "SIGNED_OUT") listener(null);
          else if ((event === "TOKEN_REFRESHED" || event === "SIGNED_IN") && session) {
            try {
              listener(toSession(session));
            } catch {
              // incomplete session payload: ignore
            }
          }
        }, 0);
      });
      return () => data.subscription.unsubscribe();
    },

    dispose() {
      void client.auth.stopAutoRefresh();
    },
  };
}
