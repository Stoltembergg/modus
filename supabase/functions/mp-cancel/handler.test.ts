import { assertEquals } from "jsr:@std/assert@1";
import type { MpCancelTarget } from "../_shared/db.ts";
import { MpApiError, type MpPreapproval } from "../_shared/mp.ts";
import { mpExpect, recorder, request, USER } from "../_shared/test-helpers.ts";
import { createMpCancelHandler, type MpCancelDeps } from "./handler.ts";

const EXPECT = mpExpect(false);
const LIVE = new Set(["incomplete", "active", "trialing", "past_due", "unpaid", "paused"]);

function pre(id: string, status: string): MpPreapproval {
  return {
    id,
    status,
    external_reference: "0b9b3b52-4c55-4c47-9d2a-7a0c8a3e5f10",
    collector_id: "777",
    amount_minor: 10990,
    currency: "BRL",
    next_payment_date: null,
    init_point: null,
  };
}

type Row = { status: string; cancelRequested: boolean };

/** A fake MP + DB with state, so repeated calls see the effect of earlier ones. */
function setup(
  o: Partial<{
    rows: Record<string, Row>;
    /** MP's status after a PUT (default "canceled"); an Error makes the PUT fail. */
    put: string | Error;
    /** MP's status on GET (default: the status the last PUT left); an Error fails the GET. */
    get: string | Error;
    putId: string;
    user: typeof USER | null;
    /** process_mp_preapproval rejects the preapproval (e.g. collector mismatch). */
    rejectProcess: boolean;
  }> = {},
) {
  const rows: Record<string, Row> = o.rows ?? {
    preA1: { status: "active", cancelRequested: false },
  };
  const mp: Record<string, string> = {};
  const { calls, record, names } = recorder();
  const deps: MpCancelDeps = {
    api: {
      cancelPreapproval: record("cancelPreapproval", (id: string) => {
        if (o.put instanceof Error) return Promise.reject(o.put);
        mp[id] = o.put ?? "canceled";
        return Promise.resolve(pre(o.putId ?? id, mp[id]));
      }),
      getPreapproval: record("getPreapproval", (id: string) => {
        if (o.get instanceof Error) return Promise.reject(o.get);
        return Promise.resolve(pre(id, o.get ?? mp[id] ?? "authorized"));
      }),
    },
    db: {
      mpCancelTargets: record("mpCancelTargets", (_u: string) =>
        Promise.resolve(
          Object.entries(rows)
            .filter(([, r]) => LIVE.has(r.status))
            .map(
              ([id, r]): MpCancelTarget => ({
                preapprovalId: id,
                status: r.status,
                cancelRequested: r.cancelRequested,
              }),
            ),
        ),
      ),
      mpMarkCancelRequested: record("mpMarkCancelRequested", (_u: string, id: string) => {
        const row = rows[id];
        if (!row || !LIVE.has(row.status)) return Promise.resolve("not_found" as const);
        row.cancelRequested = true;
        return Promise.resolve("marked" as const);
      }),
      processMpPreapproval: record(
        "processMpPreapproval",
        (p: MpPreapproval, _e: unknown, _r: string | null) => {
          if (o.rejectProcess) return Promise.resolve({ code: "rejected_collector" });
          const row = rows[p.id];
          if (row && p.status === "canceled") {
            row.status = "canceled";
            row.cancelRequested = false;
          }
          return Promise.resolve({ code: "applied" });
        },
      ),
    },
    getUser: record("getUser", () => Promise.resolve(o.user === undefined ? USER : o.user)),
    expect: EXPECT,
  };
  return { handler: createMpCancelHandler(deps), calls, names, rows };
}

async function result(res: Response) {
  return [res.status, await res.json()];
}

Deno.test("401 without a valid user; nothing is looked up or cancelled", async () => {
  const s = setup({ user: null });
  assertEquals(await result(await s.handler(request({}))), [401, { error: "unauthorized" }]);
  assertEquals(await result(await s.handler(request({}, { auth: false }))), [
    401,
    { error: "unauthorized" },
  ]);
  assertEquals(s.names(), ["getUser", "getUser"]);
});

Deno.test("405 for anything but POST", async () => {
  const s = setup();
  assertEquals((await s.handler(request({}, { method: "GET" }))).status, 405);
  assertEquals(s.names(), []);
});

Deno.test("never uses a client-provided id: any body field is 400, before any lookup", async () => {
  for (const body of [
    { preapproval_id: "evil1" },
    { id: "evil1" },
    { subscription_id: "x" },
    { user_id: USER.id },
    [],
    "x",
  ]) {
    const s = setup();
    const res = await s.handler(request(body));
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(s.names(), ["getUser"], JSON.stringify(body));
  }
});

Deno.test("empty body or {} is accepted; ids come from the user's own rows", async () => {
  for (const body of ["", {}]) {
    const s = setup();
    assertEquals(await result(await s.handler(request(body))), [200, { code: "canceled" }]);
    assertEquals(s.calls[1], { name: "mpCancelTargets", args: [USER.id] });
    assertEquals(s.calls[2], { name: "cancelPreapproval", args: ["preA1"] });
  }
});

Deno.test("no live subscription -> 200 no_subscription, no Mercado Pago call", async () => {
  const s = setup({ rows: { old1: { status: "canceled", cancelRequested: false } } });
  assertEquals(await result(await s.handler(request({}))), [200, { code: "no_subscription" }]);
  assertEquals(s.names(), ["getUser", "mpCancelTargets"]);
});

Deno.test("cancel confirmed by the PUT: applied via process_mp_preapproval, row leaves live", async () => {
  const s = setup();
  assertEquals(await result(await s.handler(request({}))), [200, { code: "canceled" }]);
  assertEquals(s.names(), [
    "getUser",
    "mpCancelTargets",
    "cancelPreapproval",
    "processMpPreapproval",
    "mpMarkCancelRequested",
  ]);
  const [p, e, r] = s.calls[3].args as [MpPreapproval, unknown, unknown];
  assertEquals([p.id, p.status, e, r], ["preA1", "canceled", EXPECT, null]);
  assertEquals(s.rows.preA1, { status: "canceled", cancelRequested: false });
});

Deno.test("PUT accepted but MP not canceled yet -> cancel_requested, status untouched", async () => {
  const s = setup({ put: "authorized" });
  assertEquals(await result(await s.handler(request({}))), [200, { code: "cancel_requested" }]);
  assertEquals(s.names().includes("processMpPreapproval"), false);
  assertEquals(s.names().includes("getPreapproval"), true, "re-read before giving up");
  assertEquals(s.rows.preA1, { status: "active", cancelRequested: true });
});

Deno.test("PUT fails but GET shows canceled (already cancelled at MP) -> applied", async () => {
  const s = setup({ put: new MpApiError(400, "http"), get: "canceled" });
  assertEquals(await result(await s.handler(request({}))), [200, { code: "canceled" }]);
  assertEquals(s.rows.preA1.status, "canceled");
});

Deno.test("MP errors: PUT and GET fail -> 502 mercadopago_unavailable, nothing changed", async () => {
  for (const get of [new MpApiError(503, "http"), "authorized"] as const) {
    const s = setup({ put: new MpApiError(503, "network"), get });
    assertEquals(await result(await s.handler(request({}))), [
      502,
      { error: "mercadopago_unavailable" },
    ]);
    assertEquals(s.names().includes("processMpPreapproval"), false);
    assertEquals(s.names().includes("mpMarkCancelRequested"), false);
    assertEquals(s.rows.preA1, { status: "active", cancelRequested: false });
  }
});

Deno.test("an unexpected error is a 500 without details", async () => {
  const s = setup({ put: new Error("boom"), get: new Error("boom") });
  assertEquals(await result(await s.handler(request({}))), [500, { error: "internal_error" }]);
});

Deno.test("a PUT answer for another id is not trusted", async () => {
  const s = setup({ putId: "other1", get: "authorized" });
  assertEquals(await result(await s.handler(request({}))), [
    502,
    { error: "mercadopago_unavailable" },
  ]);
  assertEquals(s.rows.preA1.status, "active");
});

Deno.test("confirmation rejected by process_mp_preapproval -> stays live, cancel_requested", async () => {
  const s = setup({ rejectProcess: true });
  assertEquals(await result(await s.handler(request({}))), [200, { code: "cancel_requested" }]);
  assertEquals(s.rows.preA1, { status: "active", cancelRequested: true });
});

Deno.test("idempotent: a repeat after a confirmed cancel is a no-op", async () => {
  const s = setup();
  assertEquals(await result(await s.handler(request({}))), [200, { code: "canceled" }]);
  assertEquals(await result(await s.handler(request({}))), [200, { code: "no_subscription" }]);
  assertEquals(s.names().filter((n) => n === "cancelPreapproval").length, 1);
});

Deno.test("idempotent: repeating an unconfirmed cancel is safe, then confirms", async () => {
  const s = setup({ put: "authorized" });
  for (let i = 0; i < 2; i++) {
    assertEquals(await result(await s.handler(request({}))), [200, { code: "cancel_requested" }]);
  }
  assertEquals(s.rows.preA1, { status: "active", cancelRequested: true });
});

Deno.test("incomplete (authorized, never paid) is cancellable too", async () => {
  const s = setup({ rows: { preI1: { status: "incomplete", cancelRequested: false } } });
  assertEquals(await result(await s.handler(request({}))), [200, { code: "canceled" }]);
  assertEquals(s.rows.preI1.status, "canceled");
});

Deno.test("several live rows: each cancelled; one unconfirmed -> cancel_requested", async () => {
  const rows = {
    preA1: { status: "active", cancelRequested: false },
    preB2: { status: "incomplete", cancelRequested: false },
  };
  const s = setup({ rows });
  assertEquals(await result(await s.handler(request({}))), [200, { code: "canceled" }]);
  assertEquals(
    s.calls.filter((c) => c.name === "cancelPreapproval").map((c) => c.args[0]),
    ["preA1", "preB2"],
  );
});

Deno.test("the response never carries a preapproval id", async () => {
  for (const put of ["canceled", "authorized"]) {
    const res = await setup({ put }).handler(request({}));
    const text = await res.text();
    assertEquals(text.includes("preA1"), false, text);
  }
});
