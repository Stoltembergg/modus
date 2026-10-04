import { assertRejects } from "jsr:@std/assert@1";

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
