import type { AuthOAuthProviderId } from "../../shared/auth";

/**
 * What the auth service needs from Supabase, kept narrow so the service is testable without the
 * network. Tokens appear here because this interface lives entirely in the main process.
 */
export type AuthBackendUser = {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  provider: string;
  metadata: Record<string, unknown>;
};

export type AuthBackendSession = {
  accessToken: string;
  refreshToken: string;
  user: AuthBackendUser;
};

export type AuthBackendProfile = { displayName: string | null; avatarUrl: string | null };

export type AuthBackendErrorKind = "rejected" | "network" | "other";

export class AuthBackendError extends Error {
  readonly kind: AuthBackendErrorKind;
  constructor(kind: AuthBackendErrorKind, message: string) {
    super(message);
    this.name = "AuthBackendError";
    this.kind = kind;
  }
}

export interface AuthBackend {
  /** session is null while the email still needs confirmation. */
  signUp(email: string, password: string): Promise<{ session: AuthBackendSession | null }>;
  signInWithPassword(email: string, password: string): Promise<AuthBackendSession>;
  /** PKCE authorize URL for the browser; the code_verifier stays inside the backend (memory). */
  createOAuthUrl(provider: AuthOAuthProviderId, redirectTo: string): Promise<string>;
  exchangeCode(code: string): Promise<AuthBackendSession>;
  restore(refreshToken: string): Promise<AuthBackendSession>;
  signOut(): Promise<void>;
  fetchProfile(userId: string): Promise<AuthBackendProfile | null>;
  /**
   * The current access token (supabase-js refreshes it first when it is about to expire), or
   * null without a session. Main process only: the model router adapter (B4b) reads it per
   * request; it never crosses IPC and is never persisted.
   */
  getAccessToken(): Promise<string | null>;
  /** Forces a refresh of the current session; resolves with the new access token. */
  refreshAccessToken(): Promise<string>;
  /** Token refreshes and server-side sign-outs; null = signed out. */
  onSessionChange(listener: (session: AuthBackendSession | null) => void): () => void;
  dispose(): void;
}
