/**
 * Function configuration from env. Every billing Function refuses to start
 * unless STRIPE_SECRET_KEY is a TEST-mode secret key (`sk_test_`): live mode
 * needs its own reviewed migration and deploy (PLAN-auth-billing.md, B3 live lock).
 */
export type EnvSource = { get(key: string): string | undefined };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(env: EnvSource, key: string): string {
  const value = env.get(key)?.trim();
  if (!value) throw new ConfigError(`${key} is not set.`);
  return value;
}

/** Only `sk_test_…` passes: live keys, restricted keys and publishable keys are refused. */
export function requireTestModeStripeKey(env: EnvSource): string {
  const key = env.get("STRIPE_SECRET_KEY")?.trim() ?? "";
  if (!key.startsWith("sk_test_") || key.length <= "sk_test_".length) {
    throw new ConfigError("STRIPE_SECRET_KEY must be a test-mode secret key (sk_test_…).");
  }
  return key;
}

export function requireWebhookSecret(env: EnvSource): string {
  const secret = required(env, "STRIPE_WEBHOOK_SECRET");
  if (!secret.startsWith("whsec_")) {
    throw new ConfigError("STRIPE_WEBHOOK_SECRET must be a webhook signing secret (whsec_…).");
  }
  return secret;
}

export type SupabaseConfig = { url: string; anonKey: string; dbUrl: string };

/** Provided by the Supabase Edge runtime (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_DB_URL). */
export function loadSupabaseConfig(env: EnvSource): SupabaseConfig {
  const url = required(env, "SUPABASE_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new ConfigError("SUPABASE_URL must be an http(s) URL.");
  return {
    url,
    anonKey: required(env, "SUPABASE_ANON_KEY"),
    dbUrl: required(env, "SUPABASE_DB_URL"),
  };
}

/**
 * Where Stripe sends the browser back. Stripe Checkout / Portal need an https
 * page (custom schemes such as modus:// are not documented as accepted), so the
 * base is an https page that forwards to modus://billing/return?status=…
 * (template: supabase/billing-return/index.html). Never taken from the client.
 */
export const DEFAULT_BILLING_RETURN_URL = "https://github.com/Stoltembergg/modus";

export type BillingUrls = { successUrl: string; cancelUrl: string; portalReturnUrl: string };

export function loadBillingUrls(env: EnvSource): BillingUrls {
  const raw = env.get("BILLING_RETURN_URL")?.trim() || DEFAULT_BILLING_RETURN_URL;
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new ConfigError("BILLING_RETURN_URL is not a valid URL.");
  }
  if (base.protocol !== "https:" || base.search || base.hash || base.username || base.password) {
    throw new ConfigError(
      "BILLING_RETURN_URL must be a plain https URL without query or fragment.",
    );
  }
  const withStatus = (status: string) => {
    const url = new URL(base.href);
    url.searchParams.set("modus_billing", status);
    return url.href;
  };
  return {
    successUrl: withStatus("success"),
    cancelUrl: withStatus("cancel"),
    portalReturnUrl: withStatus("portal"),
  };
}
