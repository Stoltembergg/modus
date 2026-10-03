import { AUTH_OAUTH_PROVIDER_IDS, type AuthOAuthProviderId } from "../../shared/auth";
import type { OAuthTransport } from "./oauth-callback";

/**
 * Supabase Auth settings for the desktop app. Read in the main process only.
 *
 * Sources, first match wins:
 * - runtime env: MODUS_SUPABASE_URL, MODUS_SUPABASE_ANON_KEY, MODUS_AUTH_OAUTH_PROVIDERS,
 *   MODUS_AUTH_OAUTH_TRANSPORT, MODUS_AUTH_EMAIL_REDIRECT_URL
 * - build-time env (electron-vite, main only): MAIN_VITE_SUPABASE_URL, MAIN_VITE_SUPABASE_ANON_KEY,
 *   MAIN_VITE_AUTH_OAUTH_PROVIDERS, MAIN_VITE_AUTH_OAUTH_TRANSPORT, MAIN_VITE_AUTH_EMAIL_REDIRECT_URL
 *
 * The anon / publishable key is public by design (RLS protects the data), but it is still never
 * committed: builds receive it from env. A service_role / secret key is refused outright.
 */
export type AuthConfig = {
  supabaseUrl: string;
  anonKey: string;
  /** OAuth providers enabled for this build ("github,google"); empty until their secrets exist. */
  oauthProviders: AuthOAuthProviderId[];
  /**
   * "loopback" (default): http://127.0.0.1:<port>/auth/callback, no allow-list entry needed.
   * "deep-link": modus://auth/callback (allow-list entry `modus://auth/callback`).
   */
  oauthTransport?: OAuthTransport;
  /**
   * Where the sign-up confirmation email lands (apps/site /auth/confirmed). Unset: Supabase's
   * Site URL. Must also be in the Supabase redirect allow-list.
   */
  emailRedirectUrl?: string;
};

export type AuthConfigEnv = Record<string, string | undefined>;

function first(env: AuthConfigEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function decodeJwtRole(key: string): string | undefined {
  const parts = key.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (payload && typeof payload === "object" && "role" in payload) {
      const role = (payload as { role: unknown }).role;
      return typeof role === "string" ? role : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Throws when the key is a privileged key: those must never ship in a desktop build. */
export function assertPublicSupabaseKey(key: string): void {
  if (key.startsWith("sb_secret_")) {
    throw new Error("Refusing a Supabase secret key in the desktop app; use the publishable key.");
  }
  const role = decodeJwtRole(key);
  if (role !== undefined && role !== "anon") {
    throw new Error("Refusing a non-anon Supabase key in the desktop app.");
  }
}

export function parseSupabaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The Supabase URL is not a valid URL.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("The Supabase URL must use https (http only for a local stack).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The Supabase URL must not carry credentials, a query or a fragment.");
  }
  return url.origin;
}

/**
 * Providers used when the build does not set MODUS_/MAIN_VITE_AUTH_OAUTH_PROVIDERS: GitHub and
 * Google are configured in Supabase (2026-10-03). "none" disables OAuth.
 */
export const DEFAULT_OAUTH_PROVIDERS: readonly AuthOAuthProviderId[] = ["github", "google"];

export function parseOAuthProviders(raw: string | undefined): AuthOAuthProviderId[] {
  if (raw === undefined) return [...DEFAULT_OAUTH_PROVIDERS];
  const wanted = new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return AUTH_OAUTH_PROVIDER_IDS.filter((id) => wanted.has(id));
}

/** https only (http on localhost / 127.0.0.1 for a local stack); no credentials or fragment. */
export function parseEmailRedirectUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The email redirect URL is not a valid URL.");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("The email redirect URL must use https.");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("The email redirect URL must not carry credentials or a fragment.");
  }
  return url.href;
}

export function parseOAuthTransport(raw: string | undefined): OAuthTransport {
  return raw?.trim().toLowerCase() === "deep-link" ? "deep-link" : "loopback";
}

function optionalEmailRedirect(raw: string | undefined): { emailRedirectUrl?: string } {
  const url = parseEmailRedirectUrl(raw);
  return url ? { emailRedirectUrl: url } : {};
}

/** undefined when the build has no Supabase settings: the Account UI then reports "unavailable". */
export function resolveAuthConfig(
  env: AuthConfigEnv,
  buildEnv: AuthConfigEnv = {},
): AuthConfig | undefined {
  const merged: AuthConfigEnv = { ...buildEnv, ...env };
  const rawUrl = first(merged, "MODUS_SUPABASE_URL", "MAIN_VITE_SUPABASE_URL");
  const anonKey = first(merged, "MODUS_SUPABASE_ANON_KEY", "MAIN_VITE_SUPABASE_ANON_KEY");
  if (!rawUrl || !anonKey) return undefined;
  assertPublicSupabaseKey(anonKey);
  return {
    supabaseUrl: parseSupabaseUrl(rawUrl),
    anonKey,
    oauthProviders: parseOAuthProviders(
      first(merged, "MODUS_AUTH_OAUTH_PROVIDERS", "MAIN_VITE_AUTH_OAUTH_PROVIDERS"),
    ),
    oauthTransport: parseOAuthTransport(
      first(merged, "MODUS_AUTH_OAUTH_TRANSPORT", "MAIN_VITE_AUTH_OAUTH_TRANSPORT"),
    ),
    ...optionalEmailRedirect(
      first(merged, "MODUS_AUTH_EMAIL_REDIRECT_URL", "MAIN_VITE_AUTH_EMAIL_REDIRECT_URL"),
    ),
  };
}
