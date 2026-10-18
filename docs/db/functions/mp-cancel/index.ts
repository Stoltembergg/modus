import { createGetUser } from "../_shared/auth.ts";
import { bootConfig, loadMpConfig, loadSupabaseConfig } from "../_shared/config.ts";
import { createPostgresBillingDb } from "../_shared/db.ts";
import { createMpApi } from "../_shared/mp.ts";
import { createMpCancelHandler } from "./handler.ts";

// Deploy with verify_jwt = true (the caller is a signed-in Modus user); the handler also
// validates the JWT itself. Called by the desktop main process (Account > Plan & credits).
// Throws at boot without a valid MP_LIVE_MODE / MP_ACCESS_TOKEN / MP_COLLECTOR_ID
// (config.ts loadMpConfig).
const { accessToken, expect } = bootConfig("mp-cancel", () => loadMpConfig(Deno.env));
const supabase = loadSupabaseConfig(Deno.env);

Deno.serve(
  createMpCancelHandler({
    api: createMpApi(accessToken),
    db: createPostgresBillingDb(supabase.dbUrl),
    getUser: createGetUser(supabase),
    expect,
  }),
);
