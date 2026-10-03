import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  ConfigError,
  loadBillingUrls,
  requireTestModeStripeKey,
  requireWebhookSecret,
} from "./config.ts";
import { env } from "./test-helpers.ts";

Deno.test("STRIPE_SECRET_KEY: only sk_test_ keys are accepted", () => {
  assertEquals(requireTestModeStripeKey(env({ STRIPE_SECRET_KEY: "sk_test_abc" })), "sk_test_abc");
  for (const key of [
    "sk_live_abc",
    "rk_test_abc",
    "rk_live_abc",
    "pk_test_abc",
    "sk_test_",
    "",
    " sk_live_x",
  ]) {
    assertThrows(() => requireTestModeStripeKey(env({ STRIPE_SECRET_KEY: key })), ConfigError);
  }
  assertThrows(() => requireTestModeStripeKey(env({})), ConfigError);
});

Deno.test("STRIPE_WEBHOOK_SECRET must be a whsec_ secret", () => {
  assertEquals(requireWebhookSecret(env({ STRIPE_WEBHOOK_SECRET: "whsec_x" })), "whsec_x");
  assertThrows(
    () => requireWebhookSecret(env({ STRIPE_WEBHOOK_SECRET: "sk_test_x" })),
    ConfigError,
  );
  assertThrows(() => requireWebhookSecret(env({})), ConfigError);
});

Deno.test("billing return URLs are built from BILLING_RETURN_URL only, with a status", () => {
  const urls = loadBillingUrls(
    env({ BILLING_RETURN_URL: " https://modus.example/billing/return " }),
  );
  assertEquals(urls.successUrl, "https://modus.example/billing/return?modus_billing=success");
  assertEquals(urls.cancelUrl, "https://modus.example/billing/return?modus_billing=cancel");
  assertEquals(urls.portalReturnUrl, "https://modus.example/billing/return?modus_billing=portal");
  // Local stack only: http on localhost / 127.0.0.1.
  assertEquals(
    loadBillingUrls(env({ BILLING_RETURN_URL: "http://127.0.0.1:3000/billing/return" })).cancelUrl,
    "http://127.0.0.1:3000/billing/return?modus_billing=cancel",
  );
  assertEquals(
    loadBillingUrls(env({ BILLING_RETURN_URL: "http://localhost:3000/billing/return" })).successUrl,
    "http://localhost:3000/billing/return?modus_billing=success",
  );
});

Deno.test("BILLING_RETURN_URL fails closed: no default, https only, no query/fragment/credentials", () => {
  assertThrows(() => loadBillingUrls(env({})), ConfigError, "not set");
  assertThrows(() => loadBillingUrls(env({ BILLING_RETURN_URL: "" })), ConfigError, "not set");
  assertThrows(() => loadBillingUrls(env({ BILLING_RETURN_URL: "   " })), ConfigError, "not set");
  for (const bad of [
    "http://modus.example/billing/return",
    "http://localhost.evil.example/r",
    "http://127.0.0.2/r",
    "modus://billing/return",
    "javascript:alert(1)",
    "https://x.example/?a=1",
    "https://x.example/#frag",
    "https://user:pw@x.example/r",
    "nope",
    "//x.example/r",
  ]) {
    assertThrows(
      () => loadBillingUrls(env({ BILLING_RETURN_URL: bad })),
      ConfigError,
      undefined,
      bad,
    );
  }
});
