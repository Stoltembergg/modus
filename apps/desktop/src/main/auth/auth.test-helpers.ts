import { vi } from "vitest";
import type { AuthOAuthProviderId } from "../../shared/auth";
import { type AuthBackend, AuthBackendError, type AuthBackendSession } from "./auth-backend";

/** Test doubles for main/auth (imported by *.test.ts only). */

export function createFakeSafeStorage({
  available = true,
  backend = "gnome_libsecret",
}: {
  available?: boolean;
  backend?: string;
} = {}) {
  return {
    isAsyncEncryptionAvailable: vi.fn(async () => available),
    getSelectedStorageBackend: vi.fn(() => backend),
    encryptStringAsync: vi.fn(async (value: string) =>
      Buffer.from(`enc:${Buffer.from(value).toString("base64")}`),
    ),
    decryptStringAsync: vi.fn(async (value: Buffer) => {
      const text = value.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("bad ciphertext");
      return {
        result: Buffer.from(text.slice(4), "base64").toString("utf8"),
        shouldReEncrypt: false,
      };
    }),
  };
}

export const SECRET_ACCESS_TOKEN = "access-token-SECRET-a1";
export const SECRET_REFRESH_TOKEN = "refresh-token-SECRET-r1";
export const SECRET_CODE = "oauth-code-SECRET-c1";

export function fakeSession(overrides: Partial<AuthBackendSession> = {}): AuthBackendSession {
  return {
    accessToken: SECRET_ACCESS_TOKEN,
    refreshToken: SECRET_REFRESH_TOKEN,
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      email: "ana@example.com",
      emailConfirmedAt: "2026-10-03T03:00:00Z",
      provider: "email",
      metadata: { full_name: "Ana", access_token: "metadata-SECRET" },
    },
    ...overrides,
  };
}

export function createFakeBackend() {
  let sessionListener: ((session: AuthBackendSession | null) => void) | undefined;
  const redirects: string[] = [];
  const backend = {
    signUp: vi.fn(async (_email: string, _password: string) => ({
      session: null as AuthBackendSession | null,
    })),
    signInWithPassword: vi.fn(async (_email: string, _password: string) => fakeSession()),
    createOAuthUrl: vi.fn(async (provider: AuthOAuthProviderId, redirectTo: string) => {
      redirects.push(redirectTo);
      return `https://crdgtmyvwdnswuggpjco.supabase.co/auth/v1/authorize?provider=${provider}`;
    }),
    exchangeCode: vi.fn(async (code: string) => {
      if (code !== SECRET_CODE) throw new AuthBackendError("rejected", "invalid flow state");
      return fakeSession({ user: { ...fakeSession().user, provider: "github" } });
    }),
    restore: vi.fn(async (_refreshToken: string) =>
      fakeSession({ refreshToken: "refresh-token-SECRET-r2" }),
    ),
    signOut: vi.fn(async () => undefined),
    getAccessToken: vi.fn(async (): Promise<string | null> => SECRET_ACCESS_TOKEN),
    refreshAccessToken: vi.fn(async () => "access-token-SECRET-a2"),
    fetchProfile: vi.fn(async (_userId: string) => ({
      displayName: "Ana Profile",
      avatarUrl: "https://example.com/a.png",
    })),
    onSessionChange: vi.fn((listener: (session: AuthBackendSession | null) => void) => {
      sessionListener = listener;
      return () => {
        sessionListener = undefined;
      };
    }),
    dispose: vi.fn(),
  } satisfies AuthBackend;
  return {
    backend,
    redirects,
    emitSession: (session: AuthBackendSession | null) => sessionListener?.(session),
  };
}
