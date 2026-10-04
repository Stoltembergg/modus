import type { GetUser } from "../_shared/auth.ts";
import type { MpExpectations } from "../_shared/config.ts";
import type { BillingDb, MpCancelTarget } from "../_shared/db.ts";
import { errorResponse, HttpError, json, readJsonObject } from "../_shared/http.ts";
import { type MpApi, MpApiError, type MpPreapproval } from "../_shared/mp.ts";

export type MpCancelDeps = {
  api: Pick<MpApi, "cancelPreapproval" | "getPreapproval">;
  db: Pick<BillingDb, "mpCancelTargets" | "mpMarkCancelRequested" | "processMpPreapproval">;
  getUser: GetUser;
  expect: MpExpectations;
};

type Outcome = "canceled" | "cancel_requested" | "failed";

function mpFailure(step: string, error: unknown): null {
  if (error instanceof MpApiError) {
    console.error(`[mp-cancel] ${step} failed:`, `${error.kind}:${error.status}`);
    return null;
  }
  throw error;
}

/**
 * L1e: POST (empty body or {}) -> { code: "no_subscription" | "canceled" | "cancel_requested" }.
 * The caller is the signed-in user (JWT checked here, not only by verify_jwt); the preapproval
 * ids come only from the database (the user's own live Mercado Pago subscriptions), never from
 * the request. Each is cancelled on Mercado Pago (PUT /preapproval/{id} status "canceled"). The
 * local status is never set here: it changes only through private.process_mp_preapproval, the
 * webhook's own path, fed with Mercado Pago's preapproval once it reads "canceled" (from the PUT
 * response or a GET). Until then the row stays live and is only flagged as cancel requested, so
 * a new checkout stays blocked. Idempotent: no live subscription is a no-op; repeats are safe.
 * No refund; credits already granted stay.
 */
export function createMpCancelHandler(deps: MpCancelDeps): (req: Request) => Promise<Response> {
  async function cancelOne(userId: string, target: MpCancelTarget): Promise<Outcome> {
    const id = target.preapprovalId;
    let putOk = false;
    let pre: MpPreapproval | null = null;
    try {
      pre = await deps.api.cancelPreapproval(id);
      putOk = pre.id === id;
    } catch (error) {
      pre = mpFailure("cancel", error);
    }
    if (!pre || pre.id !== id || pre.status !== "canceled") {
      try {
        pre = await deps.api.getPreapproval(id);
      } catch (error) {
        pre = mpFailure("refresh", error);
      }
    }
    const confirmed = pre !== null && pre.id === id && pre.status === "canceled";
    if (!confirmed && !putOk) return "failed";
    if (confirmed && pre) await deps.db.processMpPreapproval(pre, deps.expect, null);
    // Still live (not confirmed, or the confirmation was not applied): flag it, keep it live.
    const marked = await deps.db.mpMarkCancelRequested(userId, id);
    return marked === "marked" ? "cancel_requested" : "canceled";
  }

  return async (req) => {
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      const user = await deps.getUser(req);
      if (!user) throw new HttpError(401, "unauthorized");
      const body = await readJsonObject(req, { allowEmpty: true });
      if (Object.keys(body).length > 0) throw new HttpError(400, "invalid_body");

      const targets = await deps.db.mpCancelTargets(user.id);
      if (targets.length === 0) return json(200, { code: "no_subscription" });

      const outcomes: Outcome[] = [];
      for (const target of targets) outcomes.push(await cancelOne(user.id, target));
      if (outcomes.includes("failed")) throw new HttpError(502, "mercadopago_unavailable");
      return json(200, {
        code: outcomes.includes("cancel_requested") ? "cancel_requested" : "canceled",
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
