import { assertEquals } from "jsr:@std/assert@1";
import {
  hmacSha256Hex,
  MP_SIGNATURE_WINDOW_MS,
  mpManifest,
  parseMpSignature,
  timingSafeEqualHex,
  verifyMpSignature,
} from "./mp-signature.ts";

const SECRET = "unit-test-webhook-secret";
const DATA_ID = "ORD01JQ4S4KY8HWQ6NA5PXB65B3D3";
const REQ = "2066ca19-c6f1-498a-be75-1923005edd06";
const TS_MS = "1742505638683";
// Independent vector (Python hmac/hashlib over the lowercased manifest).
const VECTOR = "3b2a3e842abda2821c3b3dc6356a4eafcbccab9017caf21eecbc1172005f316f";

async function sign(dataId: string, req: string, ts: string, secret = SECRET) {
  return `ts=${ts},v1=${await hmacSha256Hex(secret, mpManifest(dataId, req, ts))}`;
}

Deno.test("manifest: id lowercased, exact format with trailing semicolon", () => {
  assertEquals(
    mpManifest(DATA_ID, REQ, TS_MS),
    `id:ord01jq4s4ky8hwq6na5pxb65b3d3;request-id:${REQ};ts:${TS_MS};`,
  );
  assertEquals(mpManifest("123456", "r", "1"), "id:123456;request-id:r;ts:1;");
});

Deno.test("HMAC matches an independent vector; uppercase data.id verifies", async () => {
  assertEquals(await hmacSha256Hex(SECRET, mpManifest(DATA_ID, REQ, TS_MS)), VECTOR);
  const ok = await verifyMpSignature({
    xSignature: `ts=${TS_MS},v1=${VECTOR}`,
    xRequestId: REQ,
    dataId: DATA_ID,
    secret: SECRET,
    nowMs: Number(TS_MS) + 1000,
  });
  assertEquals(ok, { ok: true, tsMs: Number(TS_MS) });
});

Deno.test("ts in seconds and in milliseconds, 5 minute window both ways", async () => {
  const nowMs = 1_790_000_000_000;
  for (const ts of [String(nowMs / 1000), String(nowMs)]) {
    const header = await sign("123", REQ, ts);
    assertEquals(
      (
        await verifyMpSignature({
          xSignature: header,
          xRequestId: REQ,
          dataId: "123",
          secret: SECRET,
          nowMs,
        })
      ).ok,
      true,
    );
    const late = nowMs + MP_SIGNATURE_WINDOW_MS + 1000;
    assertEquals(
      await verifyMpSignature({
        xSignature: header,
        xRequestId: REQ,
        dataId: "123",
        secret: SECRET,
        nowMs: late,
      }),
      { ok: false, reason: "expired" },
    );
    const early = nowMs - MP_SIGNATURE_WINDOW_MS - 1000;
    assertEquals(
      (
        await verifyMpSignature({
          xSignature: header,
          xRequestId: REQ,
          dataId: "123",
          secret: SECRET,
          nowMs: early,
        })
      ).ok,
      false,
    );
  }
});

Deno.test("rejects: wrong secret, other data.id, other request id, missing parts", async () => {
  const nowMs = Number(TS_MS);
  const base = { xRequestId: REQ, dataId: DATA_ID, secret: SECRET, nowMs };
  const header = `ts=${TS_MS},v1=${VECTOR}`;
  assertEquals(
    await verifyMpSignature({ ...base, xSignature: header, secret: "another-secret-value" }),
    { ok: false, reason: "mismatch" },
  );
  assertEquals(await verifyMpSignature({ ...base, xSignature: header, dataId: "999" }), {
    ok: false,
    reason: "mismatch",
  });
  assertEquals(await verifyMpSignature({ ...base, xSignature: header, xRequestId: "other" }), {
    ok: false,
    reason: "mismatch",
  });
  assertEquals(await verifyMpSignature({ ...base, xSignature: header, dataId: null }), {
    ok: false,
    reason: "missing",
  });
  assertEquals(await verifyMpSignature({ ...base, xSignature: header, xRequestId: null }), {
    ok: false,
    reason: "missing",
  });
  assertEquals(await verifyMpSignature({ ...base, xSignature: null }), {
    ok: false,
    reason: "missing",
  });
});

Deno.test("header parsing is strict", () => {
  const v1 = "a".repeat(64);
  assertEquals(parseMpSignature(`ts=1,v1=${v1}`), { ts: "1", v1 });
  assertEquals(parseMpSignature(` ts=1 , v1=${v1.toUpperCase()} `), { ts: "1", v1 });
  for (const bad of [
    "",
    `ts=1`,
    `v1=${v1}`,
    `ts=1,v1=${v1},ts=2`,
    `ts=1,v1=${v1},v2=${v1}`,
    `ts=abc,v1=${v1}`,
    `ts=1,v1=${v1.slice(1)}`,
    `ts=1,v1=${"g".repeat(64)}`,
    `ts=1;v1=${v1}`,
  ]) {
    assertEquals(parseMpSignature(bad), null, bad);
  }
});

Deno.test("constant-time compare: equal / different / different length", () => {
  assertEquals(timingSafeEqualHex("ab", "ab"), true);
  assertEquals(timingSafeEqualHex("ab", "ac"), false);
  assertEquals(timingSafeEqualHex("ab", "abc"), false);
});
