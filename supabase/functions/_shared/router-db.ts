import postgres, { type TransactionSql } from "npm:postgres@3.4.9";

/**
 * Data access for the model-router. Same pattern as db.ts: one transaction per call,
 * SET LOCAL ROLE service_role, private RPCs over SUPABASE_DB_URL.
 */
export type ClaimResult = "claimed" | "idempotency_replay" | "idempotency_conflict";

export type UserPlan = { plan: string; allowedModels: string[] | null };

export type SettleArgs = {
  userId: string;
  requestId: string;
  credits: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
};

export type SettleResult = { code: string; charged: number; reserved: number };

/** Thrown by reserve(): the router maps it to 402 / 429. */
export class ReserveError extends Error {
  constructor(readonly code: "insufficient_credits" | "too_many_requests") {
    super(code);
    this.name = "ReserveError";
  }
}

export interface RouterDb {
  claimRequest(userId: string, key: string, bodySha256: string): Promise<ClaimResult>;
  /** The caller's plan: the highest active/trialing subscription plan, else free. */
  getPlan(userId: string): Promise<UserPlan>;
  /** Wallet balance (spendable credits); null when the user has no wallet. */
  getBalance(userId: string): Promise<number | null>;
  /** private.router_reserve; throws ReserveError for 402 / 429. */
  reserve(userId: string, requestId: string, amount: number, maxActive: number): Promise<void>;
  /** private.settle_usage (capped at the reservation; 0 credits = full release). */
  settle(args: SettleArgs): Promise<SettleResult>;
  /**
   * private.router_store_cost: keep a computed cost on the router_requests row when
   * settle keeps failing, so the expiry sweep charges it instead of refunding.
   */
  storeCost(args: SettleArgs): Promise<boolean>;
}

/** Subscription statuses that unlock the paid plan's models (judgment call: not past_due). */
export const PLAN_STATUSES = ["active", "trialing"];
/**
 * L1g: a cancelled Mercado Pago subscription keeps its plan until current_period_end
 * (status 'canceled' + cancel_at_period_end, set by process_mp_preapproval only for a paid
 * row). After that date the same query no longer matches: Free, with nothing to run.
 */
/**
 * L5a: purchased credits also unlock models: private.purchase_access_plan(user) is the
 * highest credit_packs.access_plan among the user's lots with remaining > 0 (null for a
 * blocked account: blocked subscription or a charged-back purchase). getPlan returns the
 * highest plan (by monthly_credits) of the subscription plan and that purchase plan.
 */

export function createPostgresRouterDb(dbUrl: string): RouterDb {
  const sql = postgres(dbUrl, { max: 2, idle_timeout: 20, prepare: false });

  async function asServiceRole<T>(run: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx`set local role service_role`;
      return await run(tx);
    })) as T;
  }

  return {
    claimRequest: (userId, key, bodySha256) =>
      asServiceRole(async (tx) => {
        const rows =
          await tx`select private.router_claim_request(${userId}, ${key}, ${bodySha256}) as r`;
        return rows[0].r.code as ClaimResult;
      }),

    getPlan: (userId) =>
      asServiceRole(async (tx) => {
        const rows = await tx`
          select p.plan, p.allowed_models
            from public.plans p
           where p.plan = coalesce(
             (select c.plan
                from (select s.plan
                        from public.subscriptions s
                       where s.user_id = ${userId}
                         and (s.status = any(${PLAN_STATUSES})
                              or (s.provider = 'mercadopago' and s.status = 'canceled'
                                  and s.cancel_at_period_end and s.current_period_end > now()))
                      union all
                      select private.purchase_access_plan(${userId})) c
                join public.plans sp on sp.plan = c.plan
               order by sp.monthly_credits desc, c.plan
               limit 1),
             'free')`;
        if (!rows.length) return { plan: "free", allowedModels: [] };
        return { plan: rows[0].plan, allowedModels: rows[0].allowed_models ?? null };
      }),

    getBalance: (userId) =>
      asServiceRole(async (tx) => {
        const rows = await tx`select balance from public.credit_wallets where user_id = ${userId}`;
        return rows.length ? Number(rows[0].balance) : null;
      }),

    reserve: async (userId, requestId, amount, maxActive) => {
      try {
        await asServiceRole(async (tx) => {
          const rows = await tx`
            select private.router_reserve(${userId}, ${requestId}, ${amount}, ${maxActive}) as r`;
          // The key was claimed first, so an existing reservation cannot be ours.
          if (rows[0].r.created !== true) throw new ReserveError("too_many_requests");
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "P0402" || code === "P0404") throw new ReserveError("insufficient_credits");
        if (code === "P0429") throw new ReserveError("too_many_requests");
        throw error;
      }
    },

    settle: (args) =>
      asServiceRole(async (tx) => {
        const rows = await tx`
          select private.settle_usage(${args.userId}, ${args.requestId}, ${args.credits},
                                      ${args.model}, ${args.provider},
                                      ${args.inputTokens}, ${args.outputTokens}) as r`;
        const r = rows[0].r as Record<string, unknown>;
        return {
          code: String(r.code),
          charged: Number(r.charged ?? 0),
          reserved: Number(r.reserved ?? 0),
        };
      }),

    storeCost: (args) =>
      asServiceRole(async (tx) => {
        const rows = await tx`
          select private.router_store_cost(${args.userId}, ${args.requestId}, ${args.credits},
                                           ${args.model}, ${args.provider},
                                           ${args.inputTokens}, ${args.outputTokens}) as stored`;
        return rows[0].stored === true;
      }),
  };
}
