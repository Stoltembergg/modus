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
        const subs = calls.filter((c) => c.url.includes("/rest/v1/subscriptions"));
        const params = subs.map((c) => new URL(c.url).searchParams);
        expect(params.map((p) => p.get("status"))).toEqual([
          "in.(active,trialing,past_due,unpaid,incomplete,paused)",
          "eq.canceled",
        ]);
        // L1g grace read: own Mercado Pago row, cancelled, paid until a future period end.
        const grace = params[1];
        expect(grace?.get("provider")).toBe("eq.mercadopago");
        expect(grace?.get("cancel_at_period_end")).toBe("eq.true");
        expect(grace?.get("current_period_end")).toMatch(/^gt\.\d{4}-\d{2}-\d{2}T/);
        expect(grace?.get("user_id")).toBe("eq.11111111-1111-4111-8111-111111111111");
      } finally {
        backend.dispose();
      }
    });

    it("fetchBilling prefers the live row and falls back to the L1g grace row", async () => {
      const row = (status: string, ending: boolean) => ({
        plan: "starter",
        provider: "mercadopago",
        status,
        current_period_end: "2099-01-01T00:00:00Z",
        cancel_at_period_end: ending,
        cancel_requested_at: null,
        updated_at: "2026-10-03T00:00:00Z",
      });
      for (const [live, expected] of [
        [row("active", false), "active"],
        [null, "canceled"],
      ] as const) {
        const { backend } = withFetch(() => Response.json([]));
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input instanceof Request ? input.url : input));
            if (!url.pathname.endsWith("/subscriptions")) return Response.json([]);
            const body =
              url.searchParams.get("status") === "eq.canceled" ? row("canceled", true) : live;
            return Response.json(body ? [body] : []);
          }),
        );
        try {
          const snapshot = await backend.fetchBilling("11111111-1111-4111-8111-111111111111");
          expect(snapshot.subscription?.status).toBe(expected);
          expect(snapshot.subscription?.cancelAtPeriodEnd).toBe(expected === "canceled");
        } finally {
          backend.dispose();
        }
      }
    });

    it("fetchBilling reads credit_lots as remaining + status only (RLS filters) and sums credited lots", async () => {
      const lotsResponses: Array<() => Response> = [
        () =>
          Response.json([
            { remaining: 4000, status: "credited" },
            { remaining: 5000, status: "credited" },
            { remaining: 700, status: "refunded" },
            { remaining: 300, status: "charged_back" },
            { remaining: 0, status: "credited" },
          ]),
        () => Response.json({ message: "permission denied" }, { status: 403 }),
      ];
      for (const lots of lotsResponses) {
        const { backend } = withFetch(() => Response.json([]));
        const urls: URL[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input instanceof Request ? input.url : input));
            urls.push(url);
            if (url.pathname.endsWith("/credit_lots")) return lots();
            if (url.pathname.endsWith("/credit_wallets")) {
              return Response.json({
                balance: 9640,
                reserved: 0,
                plan_allowance: 1000,
                period_end: null,
              });
            }
            return Response.json([]);
          }),
        );
        try {
          const snapshot = await backend.fetchBilling("11111111-1111-4111-8111-111111111111");
          const lotReads = urls.filter((url) => url.pathname.endsWith("/credit_lots"));
          expect(lotReads).toHaveLength(1);
          // The authenticated column grant has no user_id: no user_id filter, two columns only.
          expect([...(lotReads[0]?.searchParams.keys() ?? [])]).toEqual(["select"]);
          expect(lotReads[0]?.searchParams.get("select")).toBe("remaining,status");
          if (lots === lotsResponses[0]) {
            expect(snapshot.wallet).toMatchObject({
              balance: 9640,
              purchased: 9000,
              allowance: 640,
            });
          } else {
            // Lots unreadable: the balance still shows, without a breakdown.
            expect(snapshot.wallet?.balance).toBe(9640);
            expect(snapshot.wallet).not.toHaveProperty("purchased");
            expect(snapshot.wallet).not.toHaveProperty("allowance");
          }
        } finally {
          backend.dispose();
        }
      }
    });

    it("fetchBilling reads shortfall_owed in its own query; an error there keeps the rest", async () => {
      const shortfallResponses: Array<() => Response> = [
        () => Response.json({ shortfall_owed: 4000 }),
        () =>
          Response.json(
            { message: "column credit_wallets.shortfall_owed does not exist", code: "42703" },
            { status: 400 },
          ),
        () => Response.json({ message: "permission denied" }, { status: 403 }),
      ];
      for (const shortfall of shortfallResponses) {
        const { backend } = withFetch(() => Response.json([]));
        const urls: URL[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input instanceof Request ? input.url : input));
            urls.push(url);
            if (url.pathname.endsWith("/credit_wallets")) {
              if (url.searchParams.get("select") === "shortfall_owed") {
                return shortfall();
              }
              return Response.json({
                balance: 9640,
                reserved: 0,
                plan_allowance: 1000,
                period_end: null,
              });
            }
            return Response.json([]);
          }),
        );
        try {
          const snapshot = await backend.fetchBilling("11111111-1111-4111-8111-111111111111");
          const shortfallReads = urls.filter(
            (url) =>
              url.pathname.endsWith("/credit_wallets") &&
              url.searchParams.get("select") === "shortfall_owed",
          );
          expect(shortfallReads).toHaveLength(1);
          expect(shortfallReads[0]?.searchParams.get("select")).toBe("shortfall_owed");
          expect(shortfallReads[0]?.searchParams.get("user_id")).toBe(
            "eq.11111111-1111-4111-8111-111111111111",
          );
          expect(snapshot.wallet?.balance).toBe(9640);
          if (shortfall === shortfallResponses[0]) {
            expect(snapshot.wallet?.shortfallOwed).toBe(4000);
          } else {
            expect(snapshot.wallet).not.toHaveProperty("shortfallOwed");
          }
        } finally {
          backend.dispose();
        }
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
