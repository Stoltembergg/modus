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

/**
 * L1b: STRIPE_ENABLED turns the Stripe checkout and Customer Portal Functions on. Only the exact
 * value "true" (surrounding whitespace ignored) enables them; missing, empty or anything else
 * ("1", "TRUE", "yes", "false") is DISABLED. Fail closed: a deploy that forgets the secret
 * cannot sell through Stripe (release L1 sells Starter through Mercado Pago only).
 * When disabled, create-checkout-session answers 503 {error: "stripe_disabled"} before auth,
 * the database or Stripe; create-portal-session still opens for a user with a Stripe
 * subscription row in active / trialing / past_due / unpaid (looked up server-side, never from the request) and answers 503
 * stripe_disabled to everyone else. stripe-webhook is NOT gated: it keeps processing events of
 * existing Stripe subscriptions (and their audit rows) either way.
 * Read per request, so the L1c billing catalog can reuse it to report enabled providers.
 */
export const STRIPE_ENABLED_ENV = "STRIPE_ENABLED";

export function isStripeEnabled(env: EnvSource): boolean {
  return env.get(STRIPE_ENABLED_ENV)?.trim() === "true";
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
 * Where Stripe sends the browser back: BILLING_RETURN_URL, e.g.
 * https://<site domain>/billing/return (apps/site/billing/return.html). Stripe Checkout /
 * Portal need an http(s) page, so that page forwards to the fixed modus://billing/return.
 * Required, with NO default: unset, empty or invalid fails closed (the session Functions answer
 * 503 billing_not_configured before touching Stripe). https only; http only for
 * localhost / 127.0.0.1 (local stack). success_url, cancel_url and the Portal return_url are
 * built from this value alone, never from the request.
 */
export type BillingUrls = { successUrl: string; cancelUrl: string; portalReturnUrl: string };

export function loadBillingUrls(env: EnvSource): BillingUrls {
  const raw = env.get("BILLING_RETURN_URL")?.trim();
  if (!raw) throw new ConfigError("BILLING_RETURN_URL is not set.");
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new ConfigError("BILLING_RETURN_URL is not a valid URL.");
  }
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  const schemeOk = base.protocol === "https:" || (base.protocol === "http:" && local);
  if (!schemeOk || base.search || base.hash || base.username || base.password) {
    throw new ConfigError(
      "BILLING_RETURN_URL must be a plain https URL (http only for localhost) without query, fragment or credentials.",
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

/**
 * Resolves the return URLs once, on first use. A ConfigError is logged (message only, no
 * values) and turned into a 503 so a misconfigured deploy fails closed per request instead of
 * sending users to an unknown page.
 */
export function lazyBillingUrls(env: EnvSource): () => BillingUrls {
  let cached: BillingUrls | undefined;
  return () => {
    cached ??= loadBillingUrls(env);
    return cached;
  };
}

/**
 * Mercado Pago (B6a). MP_ACCESS_TOKEN: the seller's access token (APP_USR-… or TEST-…; the
 * TEST seller today, rotated before production). Never logged.
 */
export function requireMpAccessToken(env: EnvSource): string {
  const token = env.get("MP_ACCESS_TOKEN")?.trim() ?? "";
  if (!/^(APP_USR|TEST)-[A-Za-z0-9-]{10,300}$/.test(token)) {
    throw new ConfigError(
      "MP_ACCESS_TOKEN must be a Mercado Pago access token (APP_USR-… or TEST-…).",
    );
  }
  return token;
}

/** MP_WEBHOOK_SECRET: the "secret signature" of the app's Webhooks configuration. */
export function requireMpWebhookSecret(env: EnvSource): string {
  const secret = required(env, "MP_WEBHOOK_SECRET");
  if (secret.length < 16 || /\s/.test(secret)) {
    throw new ConfigError(
      "MP_WEBHOOK_SECRET must be the webhook secret signature (16+ characters).",
    );
  }
  return secret;
}

/**
 * MP_LIVE_MODE: which Mercado Pago environment this deploy serves. REQUIRED, exactly "true"
 * (production seller, live payments) or "false" (test seller); surrounding whitespace is
 * ignored, anything else (missing, empty, "1", "TRUE", "yes") fails closed: the Function
 * throws at load and does not serve. The value never comes from a request.
 */
export const MP_LIVE_MODE_ENV = "MP_LIVE_MODE";

export function requireMpLiveMode(env: EnvSource): boolean {
  const raw = env.get(MP_LIVE_MODE_ENV)?.trim();
  if (raw === undefined || raw === "") throw new ConfigError(`${MP_LIVE_MODE_ENV} is not set.`);
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigError(`${MP_LIVE_MODE_ENV} must be exactly "true" or "false".`);
}

/**
 * What every Mercado Pago object must carry, passed to the SQL processors as
 * `{live_mode, collector_id}`: `liveMode` is MP_LIVE_MODE (payments / preapprovals with any
 * other live_mode are rejected_live_mode); MP_COLLECTOR_ID is the seller's user id (digits):
 * payments and preapprovals of any other seller are rejected.
 */
export type MpExpectations = { liveMode: boolean; collectorId: string };

/** Everything a Mercado Pago Function needs from env, validated together. */
export type MpConfig = { accessToken: string; expect: MpExpectations };

/**
 * The single source of Mercado Pago config (mp-webhook, mp-buy-credits, mp-checkout,
 * mp-cancel). MP_LIVE_MODE must agree with the access token's environment: "true" needs a
 * production token (APP_USR-…), "false" a test token (TEST-…). A mismatch refuses to start;
 * the error never contains the token or any part of it.
 */
export function loadMpConfig(env: EnvSource): MpConfig {
  const liveMode = requireMpLiveMode(env);
  const accessToken = requireMpAccessToken(env);
  const tokenIsLive = accessToken.startsWith("APP_USR-");
  if (tokenIsLive !== liveMode) {
    throw new ConfigError(`${MP_LIVE_MODE_ENV} does not match access token environment.`);
  }
  const collectorId = env.get("MP_COLLECTOR_ID")?.trim() ?? "";
  if (!/^[0-9]{1,20}$/.test(collectorId)) {
    throw new ConfigError("MP_COLLECTOR_ID must be the Mercado Pago seller user id (digits).");
  }
  return { accessToken, expect: { liveMode, collectorId } };
}

/** Same validation as loadMpConfig; only the expectations. */
export function loadMpExpectations(env: EnvSource): MpExpectations {
  return loadMpConfig(env).expect;
}

/**
 * Boot helper for the Mercado Pago Functions: runs `load` at module load; a ConfigError is
 * logged as `[name] configuration error: <message>` (messages never carry secret values) and
 * rethrown, so the Function does not start.
 */
export function bootConfig<T>(name: string, load: () => T): T {
  try {
    return load();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[${name}] configuration error: ${error.message}`);
    }
    throw error;
  }
}
