import { createGetUser } from "../_shared/auth.ts";
import {
  lazyBillingUrls,
  loadMpExpectations,
  loadSupabaseConfig,
  requireMpAccessToken,
} from "../_shared/config.ts";
import { createPostgresBillingDb } from "../_shared/db.ts";
import { createMpApi } from "../_shared/mp.ts";
import { createMpBuyCreditsHandler, mpNotificationUrl } from "./handler.ts";

// L5b. Deploy with verify_jwt = true (the caller is a signed-in Modus user); the handler also
// validates the JWT itself. Called by the desktop main process (billing:buyCredits).
// Same secrets as mp-checkout; throws at boot without MP_ACCESS_TOKEN / MP_COLLECTOR_ID.
const accessToken = requireMpAccessToken(Deno.env);
const expect = loadMpExpectations(Deno.env);
const supabase = loadSupabaseConfig(Deno.env);

Deno.serve(
  createMpBuyCreditsHandler({
    api: createMpApi(accessToken),
    db: createPostgresBillingDb(supabase.dbUrl),
    getUser: createGetUser(supabase),
    urls: lazyBillingUrls(Deno.env),
    notificationUrl: mpNotificationUrl(supabase.url),
    expect,
  }),
);
