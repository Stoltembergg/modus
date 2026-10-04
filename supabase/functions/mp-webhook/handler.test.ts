import { assert, assertEquals } from "jsr:@std/assert@1";
import type { MpExpectations } from "../_shared/config.ts";
import type { MpClaim } from "../_shared/db.ts";
import {
  MpApiError,
  type MpAuthorizedPayment,
  type MpPayment,
  type MpPreapproval,
} from "../_shared/mp.ts";
import { hmacSha256Hex, mpManifest } from "../_shared/mp-signature.ts";
import { createMpWebhookHandler, MAX_MP_BODY_BYTES, type MpWebhookDeps } from "./handler.ts";

const SECRET = "unit-test-webhook-secret";
const TOKEN = "APP_USR-must-never-be-logged";
const NOW = 1_790_000_000_000;
const EXPECT: MpExpectations = { liveMode: false, collectorId: "777" };

const PRE: MpPreapproval = {
  id: "pre1",
  status: "authorized",
  external_reference: "co-1",
  collector_id: "777",
  amount_minor: 4990,
  currency: "BRL",
  next_payment_date: null,
  init_point: null,
};
const PAY: MpPayment = {
  id: "5001",
  status: "approved",
  status_detail: "accredited",
  amount_minor: 4990,
  refunded_minor: 0,
  live_mode: false,
  collector_id: "777",
  currency: "BRL",
  external_reference: null,
};
const INVOICE: MpAuthorizedPayment = { id: "9001", preapproval_id: "pre1", payment_id: "5001" };

type Call = { name: string; args: unknown[] };

/** Fake MP API (records calls) and a fake db that mimics claim / processed semantics. */
function setup(
  overrides: Partial<{
    payment: MpPayment;
    pre: MpPreapproval;
    invoice: MpAuthorizedPayment;
    apiError: MpApiError;
    dbFailOnce: boolean;
    code: string;
    purchaseCode: string;
  }> = {},
) {
  const calls: Call[] = [];
  const processed = new Set<string>();
  let failNext = overrides.dbFailOnce ?? false;
  const api: MpWebhookDeps["api"] = {
    getPreapproval: (id) => {
      calls.push({ name: "getPreapproval", args: [id] });
      if (overrides.apiError) return Promise.reject(overrides.apiError);
      return Promise.resolve({ ...(overrides.pre ?? PRE), id: overrides.pre?.id ?? id });
    },
    getAuthorizedPayment: (id) => {
      calls.push({ name: "getAuthorizedPayment", args: [id] });
      if (overrides.apiError) return Promise.reject(overrides.apiError);
      return Promise.resolve(overrides.invoice ?? { ...INVOICE, id });
    },
    getPayment: (id) => {
      calls.push({ name: "getPayment", args: [id] });
      if (overrides.apiError) return Promise.reject(overrides.apiError);
      return Promise.resolve(overrides.payment ?? { ...PAY, id });
    },
  };
  const db: MpWebhookDeps["db"] = {
    mpClaimNotification: (requestId, topic, dataId) => {
      calls.push({ name: "claim", args: [requestId, topic, dataId] });
      return Promise.resolve<MpClaim>(processed.has(requestId) ? "duplicate" : "new");
    },
    mpFinishNotification: (requestId, result) => {
      calls.push({ name: "finish", args: [requestId, result] });
      processed.add(requestId);
      return Promise.resolve();
    },
    processMpPreapproval: (pre, expect, requestId) => {
      calls.push({ name: "processMpPreapproval", args: [pre, expect, requestId] });
      if (requestId) processed.add(requestId);
      return Promise.resolve({ code: overrides.code ?? "subscription_incomplete" });
    },
    processMpPayment: (payment, pre, expect, requestId) => {
      calls.push({ name: "processMpPayment", args: [payment, pre, expect, requestId] });
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("connection reset"));
      }
      if (requestId) processed.add(requestId);
      return Promise.resolve({ code: overrides.code ?? "credited" });
    },
    processMpPurchasePayment: (payment, expect, requestId) => {
      calls.push({ name: "processMpPurchasePayment", args: [payment, expect, requestId] });
      const code = overrides.purchaseCode ?? "not_a_purchase";
      if (code !== "not_a_purchase" && requestId) processed.add(requestId);
      return Promise.resolve({ code });
    },
  };
  const handler = createMpWebhookHandler({
    api,
    db,
    secret: SECRET,
    expect: EXPECT,
    now: () => NOW,
  });
  return { handler, calls, names: () => calls.map((c) => c.name) };
}

async function notification({
  topic = "payment",
  dataId = "5001",
  requestId = "req-1",
  ts = String(NOW),
  secret = SECRET,
  body = { type: "payment", action: "payment.updated", data: { id: "5001" }, live_mode: true },
  query = true,
  method = "POST",
  signature,
}: Partial<{
  topic: string;
  dataId: string | null;
  requestId: string | null;
  ts: string;
  secret: string;
  body: unknown;
  query: boolean;
  method: string;
  signature: string | null;
}> = {}): Promise<Request> {
  const url = new URL("http://localhost/functions/v1/mp-webhook");
  if (dataId !== null) url.searchParams.set("data.id", dataId);
  if (query) url.searchParams.set("type", topic);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (requestId !== null) headers["x-request-id"] = requestId;
  const sig =
    signature === undefined
      ? `ts=${ts},v1=${await hmacSha256Hex(secret, mpManifest(dataId ?? "", requestId ?? "", ts))}`
      : signature;
  if (sig !== null) headers["x-signature"] = sig;
  return new Request(url, {
    method,
    headers,
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test("method, size, missing data.id / x-request-id / signature", async () => {
  const { handler, calls } = setup();
  assertEquals((await handler(await notification({ method: "GET" }))).status, 405);
  assertEquals(
    (await handler(await notification({ body: "x".repeat(MAX_MP_BODY_BYTES + 1) }))).status,
    413,
  );
  const noId = await handler(await notification({ dataId: null }));
  assertEquals([noId.status, await noId.json()], [400, { error: "missing_data_id" }]);
  const noReq = await handler(await notification({ requestId: null }));
  assertEquals([noReq.status, await noReq.json()], [400, { error: "missing_request_id" }]);
  assertEquals((await handler(await notification({ signature: null }))).status, 400);
  assertEquals(calls.length, 0, "nothing reaches the MP API or the database");
});

Deno.test("invalid signature / wrong secret / expired ts -> 401 before any call", async () => {
  const { handler, calls } = setup();
  assertEquals(
    (await handler(await notification({ secret: "another-secret-value-123" }))).status,
    401,
  );
  assertEquals(
    (await handler(await notification({ ts: String(NOW - 6 * 60 * 1000) }))).status,
    401,
  );
  assertEquals(
    (await handler(await notification({ signature: `ts=${NOW},v1=${"0".repeat(64)}` }))).status,
    401,
  );
  // A valid signature for another data.id does not cover this one.
  const req = await notification({ dataId: "5001" });
  const forged = new Request(req.url.replace("data.id=5001", "data.id=5002"), {
    method: "POST",
    headers: req.headers,
    body: "{}",
  });
  assertEquals((await handler(forged)).status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("ts in seconds is accepted too", async () => {
  const { handler } = setup();
  assertEquals((await handler(await notification({ ts: String(NOW / 1000) }))).status, 200);
});

Deno.test("unknown topic: 200 ignored, no DB, no API", async () => {
  const { handler, calls } = setup();
  const res = await handler(await notification({ topic: "merchant_order" }));
  assertEquals([res.status, await res.json()], [200, { received: true, ignored: true }]);
  assertEquals(calls.length, 0);
});

Deno.test("payload is ignored: a forged body cannot credit; decision from the API refetch only", async () => {
  const { handler, calls } = setup({
    payment: { ...PAY, id: "5001", status: "pending" },
    code: "recorded",
  });
  const res = await handler(
    await notification({
      body: {
        type: "payment",
        data: {
          id: "5001",
          status: "approved",
          transaction_amount: 1,
          external_reference: "attacker",
        },
        live_mode: false,
      },
    }),
  );
  assertEquals(res.status, 200);
  const processCall = calls.find((c) => c.name === "processMpPayment");
  assert(processCall);
  // The RPC receives exactly what the API returned, nothing from the body.
  assertEquals(processCall.args[0], { ...PAY, id: "5001", status: "pending" });
  assertEquals(processCall.args[1], null, "payment topic: no invoice link");
  assertEquals(processCall.args[2], EXPECT);
});

Deno.test("subscription_authorized_payment: invoice -> preapproval -> payment -> one RPC with the link", async () => {
  const { handler, names, calls } = setup();
  const res = await handler(
    await notification({ topic: "subscription_authorized_payment", dataId: "9001" }),
  );
  assertEquals([res.status, await res.json()], [200, { received: true, code: "credited" }]);
  assertEquals(names(), [
    "claim",
    "getAuthorizedPayment",
    "getPreapproval",
    "getPayment",
    "processMpPayment",
  ]);
  const args = calls.at(-1)?.args ?? [];
  assertEquals((args[0] as MpPayment).id, "5001");
  assertEquals((args[1] as MpPreapproval).id, "pre1");
  assertEquals(args[3], "req-1", "notification marked processed inside the RPC transaction");
});

Deno.test("invoice without a payment yet: finished, nothing processed", async () => {
  const { handler, names } = setup({
    invoice: { id: "9001", preapproval_id: "pre1", payment_id: null },
  });
  const res = await handler(
    await notification({ topic: "subscription_authorized_payment", dataId: "9001" }),
  );
  assertEquals((await res.json()).code, "no_payment_yet");
  assertEquals(names(), ["claim", "getAuthorizedPayment", "finish"]);
});

Deno.test("subscription_preapproval -> process_mp_preapproval", async () => {
  const { handler, names } = setup();
  const res = await handler(
    await notification({ topic: "subscription_preapproval", dataId: "pre1" }),
  );
  assertEquals((await res.json()).code, "subscription_incomplete");
  assertEquals(names(), ["claim", "getPreapproval", "processMpPreapproval"]);
});

Deno.test("API returns another object id -> rejected_id, nothing processed", async () => {
  const { handler, names } = setup({ payment: { ...PAY, id: "6666" } });
  const res = await handler(await notification());
  assertEquals((await res.json()).code, "rejected_id");
  assertEquals(names(), ["claim", "getPayment", "finish"]);
});

Deno.test("MP 404 (simulator / unknown id) -> 200 not_found, finished (no retry loop)", async () => {
  const { handler, names } = setup({ apiError: new MpApiError(404, "not_found") });
  const res = await handler(await notification());
  assertEquals([res.status, (await res.json()).code], [200, "not_found"]);
  assertEquals(names(), ["claim", "getPayment", "finish"]);
});

Deno.test("MP 5xx / timeout -> 500 (MP retries), notification not finished", async () => {
  for (const error of [new MpApiError(503, "http"), new MpApiError(0, "timeout")]) {
    const { handler, names } = setup({ apiError: error });
    assertEquals((await handler(await notification())).status, 500);
    assertEquals(names().includes("finish"), false);
  }
});

Deno.test("DB failure then MP retry with the same x-request-id: reprocessed, then duplicate", async () => {
  const { handler, names } = setup({ dbFailOnce: true });
  const req = () =>
    notification({
      topic: "subscription_authorized_payment",
      dataId: "9001",
      requestId: "req-retry",
    });
  assertEquals((await handler(await req())).status, 500);
  const second = await handler(await req());
  assertEquals([second.status, (await second.json()).code], [200, "credited"]);
  const third = await handler(await req());
  assertEquals((await third.json()).code, "duplicate");
  assertEquals(
    names().filter((n) => n === "processMpPayment").length,
    2,
    "failed once, then processed once",
  );
});

Deno.test("rejections answer 200 (no retry loop) and logs carry ids only", async () => {
  const logs: string[] = [];
  const original = { warn: console.warn, error: console.error };
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const { handler } = setup({ code: "rejected_duplicate" });
    const res = await handler(
      await notification({
        topic: "subscription_authorized_payment",
        dataId: "9001",
        body: { email: "payer@example.com" },
      }),
    );
    assertEquals([res.status, (await res.json()).code], [200, "rejected_duplicate"]);
    const failing = setup({ apiError: new MpApiError(500, "http") });
    await failing.handler(await notification());
  } finally {
    console.warn = original.warn;
    console.error = original.error;
  }
  assert(logs.length >= 2);
  for (const line of logs) {
    for (const secret of [SECRET, TOKEN, "payer@example.com", "v1="]) {
      assertEquals(line.includes(secret), false, `log leaks ${secret}`);
    }
  }
});

Deno.test("L5a payment topic: a credit-pack purchase is processed first, subscription path skipped", async () => {
  const { handler, names, calls } = setup({ purchaseCode: "credited" });
  const res = await handler(await notification());
  assertEquals([res.status, await res.json()], [200, { received: true, code: "credited" }]);
  assertEquals(names(), ["claim", "getPayment", "processMpPurchasePayment"]);
  const args = calls.at(-1)?.args ?? [];
  assertEquals(args[0], { ...PAY, id: "5001" }, "the API payment, nothing from the body");
  assertEquals(args[1], EXPECT);
  assertEquals(args[2], "req-1", "notification finished inside the purchase RPC transaction");
});

Deno.test("L5a payment topic: not a purchase -> falls back to the subscription payment path", async () => {
  const { handler, names, calls } = setup({ code: "unlinked" });
  const res = await handler(await notification());
  assertEquals((await res.json()).code, "unlinked");
  assertEquals(names(), ["claim", "getPayment", "processMpPurchasePayment", "processMpPayment"]);
  assertEquals(calls.at(-1)?.args[1], null);
});

Deno.test("L5a payment topic: purchase rejections answer 200 and are not reprocessed", async () => {
  for (const code of ["rejected_amount", "rejected_duplicate", "rejected_blocked", "pending"]) {
    const { handler, names } = setup({ purchaseCode: code });
    const res = await handler(await notification({ requestId: `req-${code}` }));
    assertEquals([res.status, (await res.json()).code], [200, code]);
    assertEquals(names().includes("processMpPayment"), false);
    const again = await handler(await notification({ requestId: `req-${code}` }));
    assertEquals((await again.json()).code, "duplicate");
  }
});

Deno.test("L5a subscription topics never go through the purchase processor", async () => {
  const { handler, names } = setup();
  await handler(await notification({ topic: "subscription_authorized_payment", dataId: "9001" }));
  await handler(
    await notification({ topic: "subscription_preapproval", dataId: "pre1", requestId: "req-2" }),
  );
  assertEquals(names().includes("processMpPurchasePayment"), false);
});
