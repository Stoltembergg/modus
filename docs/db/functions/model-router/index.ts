import { createGetUser } from "../_shared/auth.ts";
import { loadSupabaseConfig } from "../_shared/config.ts";
import { MODEL_CATALOG } from "../_shared/model-catalog.ts";
import { createPostgresRouterDb } from "../_shared/router-db.ts";
import { routerConfigFromEnv } from "./config.ts";
import { createRouterHandler } from "./handler.ts";

// Deploy with verify_jwt = true (the gateway rejects calls without a valid JWT before
// this code runs); the handler still validates the user with GoTrue (auth.getUser).
const supabase = loadSupabaseConfig(Deno.env);
const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } })
  .EdgeRuntime;

Deno.serve(
  createRouterHandler({
    db: createPostgresRouterDb(supabase.dbUrl),
    getUser: createGetUser(supabase),
    config: routerConfigFromEnv(Deno.env),
    catalog: MODEL_CATALOG,
    waitUntil: runtime ? (promise) => runtime.waitUntil(promise) : undefined,
  }),
);
