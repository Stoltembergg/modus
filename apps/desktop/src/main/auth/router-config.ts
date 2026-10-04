/**
 * The Modus model router URL (B4b). Fixed: derived from the build / runtime Supabase project
 * (`AuthConfig.supabaseUrl`, the same host that issues the JWT), never from provider config,
 * models.json or user input, so the access token cannot be sent to another host.
 * https is required in packaged builds; plain http only for localhost / 127.0.0.1 in dev.
 */
export const MODEL_ROUTER_PATH = "/functions/v1/model-router";

export function modelRouterUrl(supabaseUrl: string, options: { packaged: boolean }): string {
  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new Error("The model router URL is not a valid URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The model router URL must not carry credentials, a query or a fragment.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const allowed =
    url.protocol === "https:" || (!options.packaged && loopback && url.protocol === "http:");
  if (!allowed) {
    throw new Error(
      options.packaged
        ? "The model router URL must use https."
        : "The model router URL must use https (http only for localhost).",
    );
  }
  return `${url.origin}${MODEL_ROUTER_PATH}`;
}
