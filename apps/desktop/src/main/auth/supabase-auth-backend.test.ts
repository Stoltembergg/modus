import { afterEach, describe, expect, it, vi } from "vitest";
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

  describe("cancelSubscription (L1e)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function withFetch(response: () => Response) {
      const calls: { url: string; method: string | undefined; body: unknown }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({
            url: String(input instanceof Request ? input.url : input),
            method: init?.method ?? (input instanceof Request ? input.method : undefined),
            body: init?.body,
          });
          return response();
        }),
      );
      const backend = createSupabaseAuthBackend({
        supabaseUrl: "https://crdgtmyvwdnswuggpjco.supabase.co",
        anonKey: "sb_publishable_test",
        oauthProviders: [],
      });
      return { backend, calls };
    }

    it("fetchBilling reads every live status, paused included", async () => {
      const { backend, calls } = withFetch(() => Response.json([]));
      try {
        const snapshot = await backend.fetchBilling("11111111-1111-4111-8111-111111111111");
        expect(snapshot.subscription).toBeNull();
        const subs = calls.find((c) => c.url.includes("/rest/v1/subscriptions"));
        const status = new URL(subs?.url ?? "http://x").searchParams.get("status");
        expect(status).toBe("in.(active,trialing,past_due,unpaid,incomplete,paused)");
      } finally {
        backend.dispose();
      }
    });

    it("POSTs an empty object to mp-cancel and maps the known codes", async () => {
      for (const code of ["no_subscription", "canceled", "cancel_requested"]) {
        const { backend, calls } = withFetch(() => Response.json({ code }));
        try {
          expect(await backend.cancelSubscription()).toEqual({ ok: true, code });
          expect(calls).toHaveLength(1);
          expect(calls[0]?.url).toBe(
            "https://crdgtmyvwdnswuggpjco.supabase.co/functions/v1/mp-cancel",
          );
          expect(calls[0]?.method).toBe("POST");
          expect(calls[0]?.body).toBe("{}");
        } finally {
          backend.dispose();
        }
      }
    });

    it("an unknown answer is invalid_response; a Function error keeps its code", async () => {
      const odd = withFetch(() => Response.json({ code: "PRE123", id: "PRE123" }));
      try {
        expect(await odd.backend.cancelSubscription()).toEqual({
          ok: false,
          status: 502,
          code: "invalid_response",
        });
      } finally {
        odd.backend.dispose();
      }
      const failing = withFetch(() =>
        Response.json({ error: "mercadopago_unavailable" }, { status: 502 }),
      );
      try {
        expect(await failing.backend.cancelSubscription()).toEqual({
          ok: false,
          status: 502,
          code: "mercadopago_unavailable",
        });
      } finally {
        failing.backend.dispose();
      }
    });
  });
});
