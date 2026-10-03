import { createGetUser } from "../_shared/auth.ts";
import {
  lazyBillingUrls,
  loadMpExpectations,
  loadSupabaseConfig,
  requireMpAccessToken,
} from "../_shared/config.ts";
import { createPostgresBillingDb } from "../_shared/db.ts";
import { createMpApi } from "../_shared/mp.ts";
import { createMpCheckoutHandler } from "./handler.ts";

// Deploy with verify_jwt = true (the caller is a signed-in Modus user). Server only in B6a:
// no app UI calls it yet. Throws at boot without MP_ACCESS_TOKEN / MP_COLLECTOR_ID.
const accessToken = requireMpAccessToken(Deno.env);
const expect = loadMpExpectations(Deno.env);
const supabase = loadSupabaseConfig(Deno.env);

Deno.serve(
  createMpCheckoutHandler({
    api: createMpApi(accessToken),
    db: createPostgresBillingDb(supabase.dbUrl),
    getUser: createGetUser(supabase),
    urls: lazyBillingUrls(Deno.env),
    expect,
  }),
);
