/**
 * Account (Supabase Auth) contract shared by main, preload and renderer.
 *
 * Only display data crosses IPC: tokens, the PKCE verifier and the OAuth `code`
 * stay in the main process (see main/auth/auth-service.ts).
 */

export type AuthOAuthProviderId = "github" | "google";
export type AuthProviderId = "email" | AuthOAuthProviderId;

export type AuthProviderDef =
  | { id: "email"; kind: "password"; label: string }
  | { id: AuthOAuthProviderId; kind: "oauth"; label: string };

/** Declarative provider list: adding a provider is one entry here plus its Supabase settings. */
export const AUTH_PROVIDERS: readonly AuthProviderDef[] = [
  { id: "email", kind: "password", label: "Email" },
  { id: "github", kind: "oauth", label: "GitHub" },
  { id: "google", kind: "oauth", label: "Google" },
];

export const AUTH_OAUTH_PROVIDER_IDS: readonly AuthOAuthProviderId[] = AUTH_PROVIDERS.flatMap(
  (provider) => (provider.kind === "oauth" ? [provider.id] : []),
);

export function isAuthOAuthProviderId(value: unknown): value is AuthOAuthProviderId {
  return (
    typeof value === "string" && (AUTH_OAUTH_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export type AuthUserProfile = {
  id: string;
  email: string | null;
  displayName: string | null;
  /** Only https URLs (same rule as the profiles.avatar_url CHECK). */
  avatarUrl: string | null;
  emailConfirmed: boolean;
  /** Provider used for the current session ("email", "github", "google"). */
  provider: string;
};

export type AuthStatus =
  | "unconfigured"
  | "restoring"
  | "signed-out"
  | "awaiting-oauth"
  | "signed-in";

/**
 * "encrypted": the refresh token is kept in an OS-encrypted file and the session survives restarts.
 * "memory-only": no safe OS storage (e.g. Linux basic_text); signing in again is needed after a restart.
 */
export type AuthPersistence = "encrypted" | "memory-only";

/** "session-expired": the Modus router session could not be refreshed (B4b); sign in again. */
export type AuthNotice = "confirm-email" | "session-expired";

export type AuthState = {
  status: AuthStatus;
  user: AuthUserProfile | null;
  persistence: AuthPersistence;
  /** OAuth providers enabled in this build's config (the rest are shown as unavailable). */
  oauthProviders: AuthOAuthProviderId[];
  pendingProvider: AuthOAuthProviderId | null;
  notice: AuthNotice | null;
  error: string | null;
};

export type AuthCredentialsInput = { email: string; password: string };
export type AuthOAuthInput = { provider: AuthOAuthProviderId };

export const AUTH_PASSWORD_MIN_LENGTH = 8;
/** bcrypt ignores bytes after 72; Supabase rejects longer passwords. */
export const AUTH_PASSWORD_MAX_LENGTH = 72;
