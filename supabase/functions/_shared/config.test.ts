import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  ConfigError,
  DEFAULT_BILLING_RETURN_URL,
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

Deno.test("billing return URLs are https, server-side, with a status", () => {
  const urls = loadBillingUrls(env({}));
  assertEquals(urls.successUrl, `${DEFAULT_BILLING_RETURN_URL}?modus_billing=success`);
  assertEquals(urls.cancelUrl, `${DEFAULT_BILLING_RETURN_URL}?modus_billing=cancel`);
  assertEquals(urls.portalReturnUrl, `${DEFAULT_BILLING_RETURN_URL}?modus_billing=portal`);
  assertEquals(
    loadBillingUrls(env({ BILLING_RETURN_URL: "https://modus.example/billing/return" })).successUrl,
    "https://modus.example/billing/return?modus_billing=success",
  );
  for (const bad of [
    "http://modus.example/r",
    "modus://billing/return",
    "https://x.example/?a=1",
    "nope",
  ]) {
    assertThrows(() => loadBillingUrls(env({ BILLING_RETURN_URL: bad })), ConfigError);
  }
});
