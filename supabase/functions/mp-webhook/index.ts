import {
  loadMpExpectations,
  loadSupabaseConfig,
  requireMpAccessToken,
  requireMpWebhookSecret,
} from "../_shared/config.ts";
import { createPostgresBillingDb } from "../_shared/db.ts";
import { createMpApi } from "../_shared/mp.ts";
import { createMpWebhookHandler } from "./handler.ts";

// Deploy with verify_jwt = false (Mercado Pago does not send a Supabase JWT); the request is
// authenticated by its x-signature instead. Throws at boot (the Function does not start) when
// MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET or MP_COLLECTOR_ID is missing or malformed.
const accessToken = requireMpAccessToken(Deno.env);
const secret = requireMpWebhookSecret(Deno.env);
const expect = loadMpExpectations(Deno.env);
const supabase = loadSupabaseConfig(Deno.env);

Deno.serve(
  createMpWebhookHandler({
    api: createMpApi(accessToken),
    db: createPostgresBillingDb(supabase.dbUrl),
    secret,
    expect,
  }),
);
