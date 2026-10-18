import {
  bootConfig,
  loadMpConfig,
  loadSupabaseConfig,
  requireMpWebhookSecret,
} from "../_shared/config.ts";
import { createPostgresBillingDb } from "../_shared/db.ts";
import { createMpApi } from "../_shared/mp.ts";
import { createMpWebhookHandler } from "./handler.ts";

// Deploy with verify_jwt = false (Mercado Pago does not send a Supabase JWT); the request is
// authenticated by its x-signature instead. Throws at boot (the Function does not start) when
// MP_LIVE_MODE, MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET or MP_COLLECTOR_ID is missing or malformed,
// or when MP_LIVE_MODE does not match the access token (config.ts loadMpConfig).
const { accessToken, expect } = bootConfig("mp-webhook", () => loadMpConfig(Deno.env));
const secret = bootConfig("mp-webhook", () => requireMpWebhookSecret(Deno.env));
const supabase = loadSupabaseConfig(Deno.env);

Deno.serve(
  createMpWebhookHandler({
    api: createMpApi(accessToken),
    db: createPostgresBillingDb(supabase.dbUrl),
    secret,
    expect,
  }),
);
