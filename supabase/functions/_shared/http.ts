/** JSON responses; no CORS headers: only the desktop main process calls these Functions. */
export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export const MAX_JSON_BODY_BYTES = 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "HttpError";
  }
}

/** Reads a small JSON object body; anything else is a 400. */
export async function readJsonObject(
  req: Request,
  { allowEmpty = false } = {},
): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, "body_too_large");
  }
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new HttpError(400, "invalid_body");
  }
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "json_required");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_body");
  }
  return value as Record<string, unknown>;
}

/** Billing return URLs from server config only; a missing/invalid BILLING_RETURN_URL is a 503. */
export function requireBillingUrls<T>(resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid config";
    console.error(`[billing] configuration error: ${message}`);
    throw new HttpError(503, "billing_not_configured");
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json(error.status, { error: error.code });
  console.error("[billing] unexpected error:", error instanceof Error ? error.name : typeof error);
  return json(500, { error: "internal_error" });
}
