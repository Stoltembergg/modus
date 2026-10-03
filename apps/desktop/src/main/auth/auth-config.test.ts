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
      oauthTransport: "loopback",
    });
    expect(
      resolveAuthConfig({}, { MAIN_VITE_SUPABASE_URL: URL, MAIN_VITE_SUPABASE_ANON_KEY: "k" }),
    ).toMatchObject({ anonKey: "k", oauthProviders: ["github", "google"] });
  });

  it("defaults OAuth to GitHub and Google; an explicit list or none overrides it", () => {
    const base = { MODUS_SUPABASE_URL: URL, MODUS_SUPABASE_ANON_KEY: "k" };
    expect(resolveAuthConfig(base)?.oauthProviders).toEqual(["github", "google"]);
    expect(
      resolveAuthConfig({ ...base, MODUS_AUTH_OAUTH_PROVIDERS: "none" })?.oauthProviders,
    ).toEqual([]);
    expect(
      resolveAuthConfig({ ...base, MODUS_AUTH_OAUTH_PROVIDERS: "github" })?.oauthProviders,
    ).toEqual(["github"]);
  });

  it("accepts an https email redirect (the site's /auth/confirmed) and refuses others", () => {
    const base = { MODUS_SUPABASE_URL: URL, MODUS_SUPABASE_ANON_KEY: "k" };
    expect(resolveAuthConfig(base)).not.toHaveProperty("emailRedirectUrl");
    expect(
      resolveAuthConfig(base, {
        MAIN_VITE_AUTH_EMAIL_REDIRECT_URL: "https://modus.example/auth/confirmed",
      })?.emailRedirectUrl,
    ).toBe("https://modus.example/auth/confirmed");
    for (const bad of ["http://modus.example/auth/confirmed", "modus://auth", "nope"]) {
      expect(() => resolveAuthConfig({ ...base, MODUS_AUTH_EMAIL_REDIRECT_URL: bad })).toThrow();
    }
  });

  it("selects the deep-link OAuth transport only when asked", () => {
    const base = { MODUS_SUPABASE_URL: URL, MODUS_SUPABASE_ANON_KEY: "k" };
    expect(resolveAuthConfig(base)?.oauthTransport).toBe("loopback");
    expect(
      resolveAuthConfig({ ...base, MODUS_AUTH_OAUTH_TRANSPORT: " Deep-Link " })?.oauthTransport,
    ).toBe("deep-link");
    expect(
      resolveAuthConfig(base, { MAIN_VITE_AUTH_OAUTH_TRANSPORT: "deep-link" })?.oauthTransport,
    ).toBe("deep-link");
    expect(
      resolveAuthConfig({ ...base, MODUS_AUTH_OAUTH_TRANSPORT: "custom" })?.oauthTransport,
    ).toBe("loopback");
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
