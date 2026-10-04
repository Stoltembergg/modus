import { assertEquals, assertRejects } from "jsr:@std/assert@1";

// Each Function must refuse to start (throw at module load, before Deno.serve)
// unless STRIPE_SECRET_KEY is a test-mode key.
const FUNCTIONS = ["create-checkout-session", "create-portal-session", "stripe-webhook"];

Deno.test("every billing Function refuses to boot with a live (or missing) Stripe key", async () => {
  const saved = Deno.env.get("STRIPE_SECRET_KEY");
  Deno.env.set("STRIPE_SECRET_KEY", "sk_live_must_not_boot");
  Deno.env.set("STRIPE_WEBHOOK_SECRET", "whsec_unit");
  Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
  Deno.env.set("SUPABASE_ANON_KEY", "anon");
  Deno.env.set("SUPABASE_DB_URL", "postgres://127.0.0.1:1/none");
  try {
    for (const name of FUNCTIONS) {
      await assertRejects(
        () => import(new URL(`../${name}/index.ts?live`, import.meta.url).href),
        Error,
        "test-mode secret key",
      );
    }
  } finally {
    if (saved === undefined) Deno.env.delete("STRIPE_SECRET_KEY");
    else Deno.env.set("STRIPE_SECRET_KEY", saved);
  }
});

// Each Mercado Pago Function loads its config through config.ts loadMpConfig at module load:
// a missing / invalid MP_LIVE_MODE, or one that does not match the token, stops the boot
// (before Deno.serve) and the logged reason never names the token.
const MP_FUNCTIONS = ["mp-webhook", "mp-buy-credits", "mp-checkout", "mp-cancel"];
const MP_BOOT_KEYS = ["MP_LIVE_MODE", "MP_ACCESS_TOKEN", "MP_COLLECTOR_ID", "MP_WEBHOOK_SECRET"];

Deno.test("every Mercado Pago Function refuses to boot without a valid, matching MP_LIVE_MODE", async () => {
  const saved = new Map(MP_BOOT_KEYS.map((key) => [key, Deno.env.get(key)]));
  Deno.env.set("MP_COLLECTOR_ID", "777");
  Deno.env.set("MP_WEBHOOK_SECRET", "boot-test-webhook-secret");
  Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
  Deno.env.set("SUPABASE_ANON_KEY", "anon");
  Deno.env.set("SUPABASE_DB_URL", "postgres://127.0.0.1:1/none");
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  const cases: { live: string | undefined; token: string; message: string }[] = [
    { live: undefined, token: "TEST-1234567890-boot", message: "MP_LIVE_MODE is not set" },
    { live: "yes", token: "TEST-1234567890-boot", message: "MP_LIVE_MODE must be exactly" },
    {
      live: "true",
      token: "TEST-1234567890-boot",
      message: "MP_LIVE_MODE does not match access token environment",
    },
    {
      live: "false",
      token: "APP_USR-1234567890-boot",
      message: "MP_LIVE_MODE does not match access token environment",
    },
  ];
  try {
    let n = 0;
    for (const { live, token, message } of cases) {
      if (live === undefined) Deno.env.delete("MP_LIVE_MODE");
      else Deno.env.set("MP_LIVE_MODE", live);
      Deno.env.set("MP_ACCESS_TOKEN", token);
      for (const name of MP_FUNCTIONS) {
        await assertRejects(
          () => import(new URL(`../${name}/index.ts?mp-live-${n++}`, import.meta.url).href),
          Error,
          message,
        );
      }
    }
  } finally {
    console.error = originalError;
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
  assertEquals(logged.length, cases.length * MP_FUNCTIONS.length);
  for (const name of MP_FUNCTIONS) {
    assertEquals(
      logged.filter((line) => line.startsWith(`[${name}] configuration error: MP_LIVE_MODE`))
        .length,
      cases.length,
    );
  }
  for (const line of logged) {
    for (const leak of ["APP_USR", "TEST-", "1234567890", "boot"]) {
      assertEquals(line.includes(leak), false, `leaked ${leak}: ${line}`);
    }
  }
});
