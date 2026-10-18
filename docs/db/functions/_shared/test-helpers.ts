// Test doubles for the billing Functions (imported by *.test.ts only).
import Stripe from "npm:stripe@23.0.0";
import type { AuthenticatedUser } from "./auth.ts";
import { type BillingUrls, loadMpExpectations, type MpExpectations } from "./config.ts";

export const USER: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@example.com",
};
export const URLS: BillingUrls = {
  successUrl: "https://example.com/billing?modus_billing=success",
  cancelUrl: "https://example.com/billing?modus_billing=cancel",
  portalReturnUrl: "https://example.com/billing?modus_billing=portal",
};

export function env(values: Record<string, string>) {
  return { get: (key: string) => values[key] };
}

/**
 * Mercado Pago env fixtures (never real values): the test seller (MP_LIVE_MODE=false, TEST-
 * token) and the production seller (MP_LIVE_MODE=true, APP_USR- token), same collector.
 */
export const MP_TEST_ENV: Readonly<Record<string, string>> = {
  MP_LIVE_MODE: "false",
  MP_ACCESS_TOKEN: "TEST-0000000000-fixture",
  MP_COLLECTOR_ID: "777",
};
export const MP_LIVE_ENV: Readonly<Record<string, string>> = {
  MP_LIVE_MODE: "true",
  MP_ACCESS_TOKEN: "APP_USR-0000000000-fixture",
  MP_COLLECTOR_ID: "777",
};

/** The expectations a Function would load from the fixture env (through config.ts). */
export function mpExpect(liveMode: boolean): MpExpectations {
  return loadMpExpectations(env({ ...(liveMode ? MP_LIVE_ENV : MP_TEST_ENV) }));
}

export type Call = { name: string; args: unknown[] };

export function recorder() {
  const calls: Call[] = [];
  const record =
    <A extends unknown[], R>(name: string, impl: (...args: A) => R) =>
    (...args: A): R => {
      calls.push({ name, args });
      return impl(...args);
    };
  return { calls, record, names: () => calls.map((call) => call.name) };
}

export function request(
  body: unknown,
  { method = "POST", auth = true }: { method?: string; auth?: boolean } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = "Bearer token.from.supabase";
  return new Request("http://localhost/fn", {
    method,
    headers,
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The real SDK, only for webhook signing / verification (no network). */
export const realStripe = new Stripe("sk_test_unit_only", {
  httpClient: Stripe.createFetchHttpClient(),
});
export const cryptoProvider = Stripe.createSubtleCryptoProvider();
