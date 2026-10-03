// Test doubles for the billing Functions (imported by *.test.ts only).
import Stripe from "npm:stripe@23.0.0";
import type { AuthenticatedUser } from "./auth.ts";
import type { BillingUrls } from "./config.ts";

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
