/**
 * Mercado Pago webhook signature (x-signature: "ts=<ts>,v1=<hex>").
 * Manifest: `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` with data.id from the URL query,
 * lowercased (MP docs: uppercase alphanumeric ids are lowercased in the manifest only). HMAC-SHA256
 * hex with the webhook secret, compared in constant time. data.id and x-request-id are REQUIRED
 * (the docs allow dropping missing parts; we reject instead). ts window: 5 minutes; MP documents
 * ts in milliseconds but its own example uses seconds, so both are accepted (>= 1e12 = ms).
 */
export const MP_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export type MpSignatureInput = {
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
  secret: string;
  nowMs: number;
};

export type MpSignatureResult =
  | { ok: true; tsMs: number }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

export function parseMpSignature(header: string): { ts: string; v1: string } | null {
  const fields = new Map<string, string>();
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if ((key !== "ts" && key !== "v1") || fields.has(key)) return null;
    fields.set(key, value);
  }
  const ts = fields.get("ts");
  const v1 = fields.get("v1");
  if (!ts || !v1 || !/^[0-9]{1,16}$/.test(ts) || !/^[0-9a-fA-F]{64}$/.test(v1)) return null;
  return { ts, v1: v1.toLowerCase() };
}

export function mpManifest(dataId: string, requestId: string, ts: string): string {
  return `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two equal-length lowercase hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyMpSignature(input: MpSignatureInput): Promise<MpSignatureResult> {
  if (!input.xSignature || !input.xRequestId || !input.dataId)
    return { ok: false, reason: "missing" };
  const parsed = parseMpSignature(input.xSignature);
  if (!parsed) return { ok: false, reason: "malformed" };
  const tsNum = Number(parsed.ts);
  const tsMs = tsNum >= 1e12 ? tsNum : tsNum * 1000;
  // HMAC first (constant work whatever the timestamp), then the window.
  const expected = await hmacSha256Hex(
    input.secret,
    mpManifest(input.dataId, input.xRequestId, parsed.ts),
  );
  if (!timingSafeEqualHex(expected, parsed.v1)) return { ok: false, reason: "mismatch" };
  if (Math.abs(input.nowMs - tsMs) > MP_SIGNATURE_WINDOW_MS)
    return { ok: false, reason: "expired" };
  return { ok: true, tsMs };
}
