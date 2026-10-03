import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  createMpApi,
  MP_API_BASE,
  MpApiError,
  normalizeAuthorizedPayment,
  normalizePayment,
  normalizePreapproval,
  normalizePreapprovalStatus,
  toMinor,
} from "./mp.ts";

const TOKEN = "APP_USR-unit-test-token-0000";

Deno.test("toMinor: numbers and numeric strings, max 2 decimals", () => {
  assertEquals(toMinor(109.9), 10990);
  assertEquals(toMinor("24.50"), 2450);
  assertEquals(toMinor(0), 0);
  assertEquals(toMinor(539.9), 53990);
  for (const bad of [-1, "1.234", "abc", "", null, undefined, Number.NaN, {}]) {
    assertThrows(() => toMinor(bad), MpApiError);
  }
});

Deno.test("normalizers keep only the decision fields (numbers / strings unified)", () => {
  assertEquals(
    normalizePreapproval({
      id: "2c938084726fca480172750000000000",
      status: "authorized",
      external_reference: 23546246234,
      collector_id: 100200300,
      auto_recurring: { transaction_amount: 10, currency_id: "BRL" },
      next_payment_date: "2022-01-01T11:12:25.892-04:00",
      init_point: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=x",
      payer_email: "someone@example.com",
    }),
    {
      id: "2c938084726fca480172750000000000",
      status: "authorized",
      external_reference: "23546246234",
      collector_id: "100200300",
      amount_minor: 1000,
      currency: "BRL",
      next_payment_date: "2022-01-01T11:12:25.892-04:00",
      init_point: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=x",
    },
  );
  assertEquals(
    normalizeAuthorizedPayment({
      id: 6114264375,
      preapproval_id: "2c938084726fca480172750000000000",
      transaction_amount: "24.50",
      payment: { id: 19951521071, status: "approved" },
    }),
    {
      id: "6114264375",
      preapproval_id: "2c938084726fca480172750000000000",
      payment_id: "19951521071",
    },
  );
  assertEquals(
    normalizeAuthorizedPayment({ id: 1, preapproval_id: "abc", payment: null }).payment_id,
    null,
  );
  assertEquals(
    normalizePayment({
      id: 19951521071,
      status: "approved",
      status_detail: "partially_refunded",
      transaction_amount: 109.9,
      transaction_amount_refunded: 20,
      live_mode: false,
      collector_id: 777,
      currency_id: "BRL",
      external_reference: "",
      payer: { email: "x@example.com" },
    }),
    {
      id: "19951521071",
      status: "approved",
      status_detail: "partially_refunded",
      amount_minor: 10990,
      refunded_minor: 2000,
      live_mode: false,
      collector_id: "777",
      currency: "BRL",
      external_reference: null,
    },
  );
  assertEquals(
    normalizePayment({ id: 1, status: "approved", transaction_amount: 1 }).live_mode,
    null,
  );
  assertThrows(
    () => normalizePayment({ id: "x1", status: "approved", transaction_amount: 1 }),
    MpApiError,
  );
  assertThrows(
    () =>
      normalizePreapproval({ id: "../x", status: "a", auto_recurring: { transaction_amount: 1 } }),
    MpApiError,
  );
});

Deno.test("client: fixed base URL, bearer token, no redirects; ids validated before the URL", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const api = createMpApi(TOKEN, {
    fetchImpl: (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(
        Response.json({ id: 42, status: "approved", transaction_amount: 49.9, live_mode: false }),
      );
    },
  });
  const payment = await api.getPayment("42");
  assertEquals(payment.amount_minor, 4990);
  assertEquals(seen[0].url, `${MP_API_BASE}/v1/payments/42`);
  assertEquals((seen[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
  assertEquals(seen[0].init.redirect, "error");
  // A non-numeric id never reaches fetch (no path injection): treated as not found.
  const err = await assertRejects(() => api.getPayment("42/../../x"), MpApiError);
  assertEquals(err.kind, "not_found");
  await assertRejects(() => api.getPreapproval("a/b"), MpApiError);
  await assertRejects(() => api.getAuthorizedPayment("abc"), MpApiError);
  assertEquals(seen.length, 1);
});

Deno.test("client: 404 / 5xx / timeout / bad JSON become MpApiError without the token", async () => {
  const cases: [Response | Error, string][] = [
    [new Response("{}", { status: 404 }), "not_found"],
    [new Response("oops", { status: 503 }), "http"],
    [new Response("not json", { status: 200 }), "invalid_response"],
    [new DOMException("t", "TimeoutError"), "timeout"],
    [new TypeError("network down"), "network"],
  ];
  for (const [outcome, kind] of cases) {
    const api = createMpApi(TOKEN, {
      fetchImpl: () =>
        outcome instanceof Response ? Promise.resolve(outcome) : Promise.reject(outcome),
    });
    const error = await assertRejects(() => api.getPayment("1"), MpApiError);
    assertEquals(error.kind, kind);
    assertEquals(error.message.includes(TOKEN), false);
  }
});

Deno.test("createPreapproval: pending, BRL monthly, external_reference + X-Idempotency-Key = checkout id", async () => {
  let body: Record<string, unknown> = {};
  let headers: Record<string, string> = {};
  const api = createMpApi(TOKEN, {
    fetchImpl: (_input, init) => {
      body = JSON.parse(String(init?.body));
      headers = init?.headers as Record<string, string>;
      return Promise.resolve(
        Response.json({
          id: "pre1",
          status: "pending",
          external_reference: "co-1",
          collector_id: 777,
          auto_recurring: { transaction_amount: 49.9, currency_id: "BRL" },
          init_point: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre1",
        }),
      );
    },
  });
  const pre = await api.createPreapproval(
    {
      reason: "Modus Starter",
      externalReference: "co-1",
      payerEmail: "ana@example.com",
      amountMinor: 4990,
      currency: "BRL",
      backUrl: "https://example.com/billing?modus_billing=success",
    },
    "co-1",
  );
  assertEquals(pre.id, "pre1");
  assertEquals(headers["x-idempotency-key"], "co-1");
  assertEquals(body, {
    reason: "Modus Starter",
    external_reference: "co-1",
    payer_email: "ana@example.com",
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: 49.9,
      currency_id: "BRL",
    },
    back_url: "https://example.com/billing?modus_billing=success",
    status: "pending",
  });
});

Deno.test("cancelPreapproval: PUT /preapproval/{id} { status: canceled }; id validated first", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const api = createMpApi(TOKEN, {
    fetchImpl: (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(
        Response.json({
          id: "pre1",
          status: "cancelled",
          auto_recurring: { transaction_amount: 49.9, currency_id: "BRL" },
        }),
      );
    },
  });
  const pre = await api.cancelPreapproval("pre1");
  assertEquals(pre.status, "canceled", "the 'cancelled' spelling is the same status");
  assertEquals(seen[0].url, `${MP_API_BASE}/preapproval/pre1`);
  assertEquals(seen[0].init.method, "PUT");
  assertEquals(JSON.parse(String(seen[0].init.body)), { status: "canceled" });
  await assertRejects(() => api.cancelPreapproval("../payments/1"), MpApiError);
  await assertRejects(() => api.cancelPreapproval(""), MpApiError);
  assertEquals(seen.length, 1);
});

Deno.test("normalizePreapprovalStatus: only 'cancelled' is rewritten", () => {
  assertEquals(normalizePreapprovalStatus("cancelled"), "canceled");
  assertEquals(normalizePreapprovalStatus("CANCELLED"), "canceled");
  assertEquals(normalizePreapprovalStatus("canceled"), "canceled");
  assertEquals(normalizePreapprovalStatus("authorized"), "authorized");
});
