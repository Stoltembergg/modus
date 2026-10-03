// Test doubles for the model-router (imported by tests only).
import type { CatalogModel } from "../_shared/model-catalog.ts";
import {
  type ClaimResult,
  ReserveError,
  type RouterDb,
  type SettleArgs,
  type SettleResult,
  type UserPlan,
} from "../_shared/router-db.ts";
import type { RouterConfig } from "./config.ts";
import { parseCreditMarkup } from "./pricing.ts";

export const FLASH: CatalogModel = {
  id: "deepseek/deepseek-flash",
  provider: "deepseek",
  upstreamId: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  api: "openai-completions",
  contextWindow: 1000000,
  maxTokens: 384000,
  enableGroups: ["model - china"],
  groupRatio: 1,
  cost: { input: 2.2, output: 8.5, cacheRead: 0.3 },
};
export const GLM: CatalogModel = {
  id: "zai/glm-5.3-flash",
  provider: "zai",
  upstreamId: "glm-5.3-flash",
  name: "GLM-5.3-Flash",
  api: "openai-completions",
  contextWindow: 1000000,
  maxTokens: 131072,
  enableGroups: ["model - china"],
  groupRatio: 1,
  cost: { input: 1.2, output: 3.975, cacheRead: 0.4 },
};
export const PAID: CatalogModel = { ...GLM, id: "zai/glm-paid", upstreamId: "glm-paid" };

export type Reservation = { amount: number; status: "active" | "settled"; charged?: number };

/** In-memory RouterDb with the SQL semantics that matter (cap at reserved, 4 active). */
export class FakeDb implements RouterDb {
  claims = new Map<string, string>();
  reservations = new Map<string, Reservation>();
  settles: SettleArgs[] = [];
  balance: number | null;
  plan: UserPlan;
  /** Number of upcoming settle calls that fail (Infinity = DB down). */
  settleFailures = 0;
  settleAttempts = 0;
  /** router_store_cost rows (sweep input); storeError makes it fail too. */
  stored = new Map<string, SettleArgs>();
  storeError = false;

  constructor(balance: number | null = 100000, plan?: UserPlan) {
    this.balance = balance;
    this.plan = plan ?? { plan: "free", allowedModels: [FLASH.id, GLM.id] };
  }

  claimRequest(_userId: string, key: string, sha: string): Promise<ClaimResult> {
    const existing = this.claims.get(key);
    if (existing === undefined) {
      this.claims.set(key, sha);
      return Promise.resolve("claimed");
    }
    return Promise.resolve(existing === sha ? "idempotency_replay" : "idempotency_conflict");
  }

  getPlan(): Promise<UserPlan> {
    return Promise.resolve(this.plan);
  }

  getBalance(): Promise<number | null> {
    return Promise.resolve(this.balance);
  }

  reserve(_userId: string, requestId: string, amount: number, maxActive: number): Promise<void> {
    if (this.balance === null) return Promise.reject(new ReserveError("insufficient_credits"));
    const active = [...this.reservations.values()].filter((r) => r.status === "active").length;
    if (active >= maxActive) return Promise.reject(new ReserveError("too_many_requests"));
    if (this.balance < amount) return Promise.reject(new ReserveError("insufficient_credits"));
    this.balance -= amount;
    this.reservations.set(requestId, { amount, status: "active" });
    return Promise.resolve();
  }

  settle(args: SettleArgs): Promise<SettleResult> {
    this.settleAttempts++;
    if (this.settleFailures > 0) {
      this.settleFailures--;
      return Promise.reject(new Error("db down"));
    }
    this.settles.push(args);
    const r = this.reservations.get(args.requestId);
    if (!r) return Promise.reject(new Error("reservation not found"));
    if (r.status === "settled") {
      return Promise.resolve({
        code: "already_settled",
        charged: r.charged ?? 0,
        reserved: r.amount,
      });
    }
    const charged = Math.min(args.credits, r.amount);
    r.status = "settled";
    r.charged = charged;
    this.balance = (this.balance ?? 0) + (r.amount - charged);
    return Promise.resolve({ code: "settled", charged, reserved: r.amount });
  }

  storeCost(args: SettleArgs): Promise<boolean> {
    if (this.storeError) return Promise.reject(new Error("db down"));
    if (!this.claims.has(args.requestId)) return Promise.resolve(false);
    this.stored.set(args.requestId, args);
    return Promise.resolve(true);
  }

  active(): number {
    return [...this.reservations.values()].filter((r) => r.status === "active").length;
  }
}

export function routerConfig(
  baseUrl: string,
  { apiKey = "upstream-secret", markup }: { apiKey?: string; markup?: string } = {},
): RouterConfig {
  const values: Record<string, string> = {};
  if (markup !== undefined) values.CREDIT_MARKUP = markup;
  return {
    markup: () => parseCreditMarkup({ get: (k) => values[k] }),
    upstream: () => {
      if (!apiKey) throw new Error("MODUS_UPSTREAM_API_KEY is not set.");
      return { baseUrl, apiKey };
    },
  };
}

export type Seen = { url: string; headers: Headers; body: Record<string, unknown> };

/** Fake OpenAI-compatible upstream on 127.0.0.1 (ephemeral port). */
export function fakeUpstream(respond: (seen: Seen, req: Request) => Response | Promise<Response>): {
  baseUrl: string;
  seen: Seen[];
  close: () => Promise<void>;
} {
  const seen: Seen[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const entry: Seen = { url: req.url, headers: req.headers, body: await req.json() };
    seen.push(entry);
    return await respond(entry, req);
  });
  const { port } = server.addr as Deno.NetAddr;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: async () => {
      await server.shutdown();
    },
  };
}

export function sse(events: unknown[], { done = true } = {}): string {
  return (
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "")
  );
}

export function completionRequest(
  body: unknown,
  {
    key = "key-1",
    headers = {} as Record<string, string>,
    signal,
  }: {
    key?: string | null;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Request {
  const h: Record<string, string> = {
    "content-type": "application/json",
    authorization: "Bearer user.jwt.token",
    ...headers,
  };
  if (key) h["idempotency-key"] = key;
  return new Request("http://localhost/model-router/v1/chat/completions", {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}
