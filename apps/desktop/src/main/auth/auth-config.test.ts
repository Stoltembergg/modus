import { describe, expect, it } from "vitest";
import { assertPublicSupabaseKey, resolveAuthConfig } from "./auth-config";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

const URL = "https://crdgtmyvwdnswuggpjco.supabase.co";

describe("auth config", () => {
  it("is unconfigured without a URL and key", () => {
    expect(resolveAuthConfig({})).toBeUndefined();
    expect(resolveAuthConfig({ MODUS_SUPABASE_URL: URL })).toBeUndefined();
  });

  it("reads runtime env over build-time env and keeps only known OAuth providers", () => {
    const config = resolveAuthConfig(
      {
        MODUS_SUPABASE_URL: `${URL}/`,
        MODUS_SUPABASE_ANON_KEY: "sb_publishable_runtime",
        MODUS_AUTH_OAUTH_PROVIDERS: " GitHub, facebook ,google",
      },
      { MAIN_VITE_SUPABASE_URL: "https://other.supabase.co", MAIN_VITE_SUPABASE_ANON_KEY: "x" },
    );
    expect(config).toEqual({
      supabaseUrl: URL,
      anonKey: "sb_publishable_runtime",
      oauthProviders: ["github", "google"],
    });
    expect(
      resolveAuthConfig({}, { MAIN_VITE_SUPABASE_URL: URL, MAIN_VITE_SUPABASE_ANON_KEY: "k" }),
    ).toMatchObject({ anonKey: "k", oauthProviders: [] });
  });

  it("refuses service-role and secret keys", () => {
    expect(() => assertPublicSupabaseKey(jwt({ role: "service_role" }))).toThrow();
    expect(() => assertPublicSupabaseKey("sb_secret_abc")).toThrow();
    expect(() => assertPublicSupabaseKey(jwt({ role: "anon" }))).not.toThrow();
    expect(() =>
      resolveAuthConfig({
        MODUS_SUPABASE_URL: URL,
        MODUS_SUPABASE_ANON_KEY: jwt({ role: "service_role" }),
      }),
    ).toThrow();
  });

  it("requires https (http only for a local stack) and a bare origin", () => {
    const key = "sb_publishable_x";
    expect(() =>
      resolveAuthConfig({ MODUS_SUPABASE_URL: "http://example.com", MODUS_SUPABASE_ANON_KEY: key }),
    ).toThrow();
    expect(() =>
      resolveAuthConfig({ MODUS_SUPABASE_URL: `${URL}?x=1`, MODUS_SUPABASE_ANON_KEY: key }),
    ).toThrow();
    expect(
      resolveAuthConfig({
        MODUS_SUPABASE_URL: "http://127.0.0.1:54321",
        MODUS_SUPABASE_ANON_KEY: key,
      })?.supabaseUrl,
    ).toBe("http://127.0.0.1:54321");
  });
});
