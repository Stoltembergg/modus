import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  bootConfig,
  ConfigError,
  isStripeEnabled,
  loadBillingUrls,
  loadMpConfig,
  loadMpExpectations,
  MP_LIVE_MODE_ENV,
  requireMpAccessToken,
  requireMpLiveMode,
  requireMpWebhookSecret,
  requireTestModeStripeKey,
  requireWebhookSecret,
} from "./config.ts";
import { env, MP_LIVE_ENV, MP_TEST_ENV, mpExpect } from "./test-helpers.ts";

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

Deno.test("Mercado Pago config: token, webhook secret and collector are required", () => {
  assertEquals(
    requireMpAccessToken(env({ MP_ACCESS_TOKEN: "APP_USR-1234567890-abcdef" })),
    "APP_USR-1234567890-abcdef",
  );
  assertEquals(
    requireMpAccessToken(env({ MP_ACCESS_TOKEN: "TEST-1234567890-abcdef" })),
    "TEST-1234567890-abcdef",
  );
  for (const token of [
    "",
    "sk_test_abc",
    "APP_USR-short",
    "Bearer APP_USR-1234567890",
    "APP_USR-12345678901 x",
  ]) {
    assertThrows(
      () => requireMpAccessToken(env({ MP_ACCESS_TOKEN: token })),
      ConfigError,
      "MP_ACCESS_TOKEN",
    );
  }
  assertEquals(
    requireMpWebhookSecret(env({ MP_WEBHOOK_SECRET: "0123456789abcdef0123" })),
    "0123456789abcdef0123",
  );
  for (const secret of ["", "short", "has space in it 0123"]) {
    assertThrows(
      () => requireMpWebhookSecret(env({ MP_WEBHOOK_SECRET: secret })),
      ConfigError,
      "MP_WEBHOOK_SECRET",
    );
  }
  assertEquals(loadMpExpectations(env({ ...MP_TEST_ENV, MP_COLLECTOR_ID: "123456789" })), {
    liveMode: false,
    collectorId: "123456789",
  });
  for (const id of ["", "abc", "12 3"]) {
    assertThrows(
      () => loadMpExpectations(env({ ...MP_TEST_ENV, MP_COLLECTOR_ID: id })),
      ConfigError,
      "MP_COLLECTOR_ID",
    );
  }
  // Error messages never echo the value.
  try {
    requireMpAccessToken(env({ MP_ACCESS_TOKEN: "APP_USR-secret value" }));
  } catch (error) {
    assertEquals((error as Error).message.includes("secret value"), false);
  }
});

Deno.test('STRIPE_ENABLED: only the exact value "true" enables Stripe; missing = disabled', () => {
  assertEquals(isStripeEnabled(env({ STRIPE_ENABLED: "true" })), true);
  assertEquals(isStripeEnabled(env({ STRIPE_ENABLED: " true\n" })), true, "whitespace trimmed");
  assertEquals(isStripeEnabled(env({})), false, "missing -> disabled");
  for (const value of [
    "",
    " ",
    "false",
    "0",
    "1",
    "TRUE",
    "True",
    "yes",
    "on",
    "enabled",
    "true1",
  ]) {
    assertEquals(isStripeEnabled(env({ STRIPE_ENABLED: value })), false, JSON.stringify(value));
  }
});

const LIVE_TOKEN = "APP_USR-1234567890-livesecret";
const TEST_TOKEN = "TEST-1234567890-testsecret";
const mpEnv = (liveMode: string | undefined, token: string) => {
  const values: Record<string, string> = { MP_ACCESS_TOKEN: token, MP_COLLECTOR_ID: "777" };
  if (liveMode !== undefined) values[MP_LIVE_MODE_ENV] = liveMode;
  return env(values);
};
/** No message (thrown or logged) may carry the token or its environment prefix. */
const assertNoTokenLeak = (text: string) => {
  for (const leak of [LIVE_TOKEN, TEST_TOKEN, "APP_USR", "TEST-", "1234567890", "secret"]) {
    assertEquals(text.includes(leak), false, `leaked ${leak}: ${text}`);
  }
};

Deno.test("MP_LIVE_MODE=true + APP_USR- token: live config", () => {
  assertEquals(loadMpConfig(mpEnv("true", LIVE_TOKEN)), {
    accessToken: LIVE_TOKEN,
    expect: { liveMode: true, collectorId: "777" },
  });
});

Deno.test("MP_LIVE_MODE=false + TEST- token: test config", () => {
  assertEquals(loadMpConfig(mpEnv("false", TEST_TOKEN)), {
    accessToken: TEST_TOKEN,
    expect: { liveMode: false, collectorId: "777" },
  });
  assertEquals(loadMpExpectations(mpEnv(" false\n", TEST_TOKEN)).liveMode, false, "trimmed");
});

Deno.test("MP_LIVE_MODE=true + TEST- token: refused without naming the token", () => {
  const error = assertThrows(() => loadMpConfig(mpEnv("true", TEST_TOKEN)), ConfigError);
  assertEquals(error.message, "MP_LIVE_MODE does not match access token environment.");
  assertNoTokenLeak(error.message);
});

Deno.test("MP_LIVE_MODE=false + APP_USR- token: refused without naming the token", () => {
  const error = assertThrows(() => loadMpConfig(mpEnv("false", LIVE_TOKEN)), ConfigError);
  assertEquals(error.message, "MP_LIVE_MODE does not match access token environment.");
  assertNoTokenLeak(error.message);
});

Deno.test("MP_LIVE_MODE missing or empty: fails closed", () => {
  for (const value of [undefined, "", "  "]) {
    const error = assertThrows(() => loadMpConfig(mpEnv(value, TEST_TOKEN)), ConfigError);
    assertEquals(error.message, "MP_LIVE_MODE is not set.");
  }
  assertThrows(() => loadMpExpectations(mpEnv(undefined, LIVE_TOKEN)), ConfigError, "MP_LIVE_MODE");
});

Deno.test("MP_LIVE_MODE invalid: only exactly true / false", () => {
  for (const value of ["1", "0", "TRUE", "False", "yes", "on", "live", "true false"]) {
    const error = assertThrows(() => requireMpLiveMode(env({ MP_LIVE_MODE: value })), ConfigError);
    assertEquals(error.message, 'MP_LIVE_MODE must be exactly "true" or "false".');
    assertEquals(error.message.includes(value), false, "the value is not echoed");
    assertThrows(() => loadMpConfig(mpEnv(value, LIVE_TOKEN)), ConfigError, "MP_LIVE_MODE");
  }
});

Deno.test("bootConfig logs the reason (no token) and rethrows", () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    assertThrows(
      () => bootConfig("mp-webhook", () => loadMpConfig(mpEnv("true", TEST_TOKEN))),
      ConfigError,
    );
    assertThrows(
      () => bootConfig("mp-checkout", () => loadMpConfig(mpEnv("false", LIVE_TOKEN))),
      ConfigError,
    );
  } finally {
    console.error = original;
  }
  assertEquals(logged, [
    "[mp-webhook] configuration error: MP_LIVE_MODE does not match access token environment.",
    "[mp-checkout] configuration error: MP_LIVE_MODE does not match access token environment.",
  ]);
  for (const line of logged) assertNoTokenLeak(line);
  assertEquals(
    bootConfig("x", () => 1),
    1,
  );
});

Deno.test("fixtures: both environments go through config.ts", () => {
  assertEquals(mpExpect(true), { liveMode: true, collectorId: "777" });
  assertEquals(mpExpect(false), { liveMode: false, collectorId: "777" });
  assertEquals(loadMpConfig(env({ ...MP_LIVE_ENV })).expect.liveMode, true);
});
