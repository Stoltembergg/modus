import { describe, expect, it } from "vitest";
import { createSupabaseAuthBackend } from "./supabase-auth-backend";

describe("Supabase auth backend", () => {
  it("builds a PKCE authorize URL on the project origin with the exact loopback redirect", async () => {
    const backend = createSupabaseAuthBackend({
      supabaseUrl: "https://crdgtmyvwdnswuggpjco.supabase.co",
      anonKey: "sb_publishable_test",
      oauthProviders: ["github"],
    });
    try {
      const redirectTo = "http://127.0.0.1:49152/auth/callback?state=abc";
      const url = new URL(await backend.createOAuthUrl("github", redirectTo));
      expect(url.origin).toBe("https://crdgtmyvwdnswuggpjco.supabase.co");
      expect(url.pathname).toBe("/auth/v1/authorize");
      expect(url.searchParams.get("provider")).toBe("github");
      expect(url.searchParams.get("redirect_to")).toBe(redirectTo);
      expect(url.searchParams.get("code_challenge_method")?.toLowerCase()).toBe("s256");
      expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      backend.dispose();
    }
  });
});
