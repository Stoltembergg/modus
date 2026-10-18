import type { SupabaseConfig } from "./config.ts";

export type AuthenticatedUser = { id: string; email: string | null };
export type GetUser = (req: Request) => Promise<AuthenticatedUser | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The caller is whoever the Supabase access token says (GoTrue /auth/v1/user
 * validates signature, expiry and revocation). Never a user id from the body.
 */
export function createGetUser(
  config: Pick<SupabaseConfig, "url" | "anonKey">,
  fetchImpl: typeof fetch = fetch,
): GetUser {
  return async (req) => {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    if (!match) return null;
    const response = await fetchImpl(`${config.url}/auth/v1/user`, {
      headers: { authorization: `Bearer ${match[1]}`, apikey: config.anonKey },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { id?: unknown; email?: unknown; role?: unknown };
    if (typeof body.id !== "string" || !UUID.test(body.id)) return null;
    if (body.role !== undefined && body.role !== "authenticated") return null;
    return { id: body.id, email: typeof body.email === "string" ? body.email : null };
  };
}
