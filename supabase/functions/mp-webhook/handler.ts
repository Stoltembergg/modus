import type { MpExpectations } from "../_shared/config.ts";
import type { BillingDb } from "../_shared/db.ts";
import { json } from "../_shared/http.ts";
import { type MpApi, MpApiError } from "../_shared/mp.ts";
import { verifyMpSignature } from "../_shared/mp-signature.ts";

export type MpWebhookDeps = {
  api: Pick<MpApi, "getPreapproval" | "getAuthorizedPayment" | "getPayment">;
  db: Pick<
    BillingDb,
    "mpClaimNotification" | "mpFinishNotification" | "processMpPreapproval" | "processMpPayment"
  >;
  secret: string;
  expect: MpExpectations;
  now?: () => number;
};

export const MAX_MP_BODY_BYTES = 64 * 1024;

/** Topics with an effect; everything else is acknowledged (200) without touching anything. */
export const MP_TOPICS = [
  "subscription_preapproval",
  "subscription_authorized_payment",
  "payment",
] as const;
type Topic = (typeof MP_TOPICS)[number];

const DATA_ID = /^[A-Za-z0-9-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function isTopic(value: string | null): value is Topic {
  return value !== null && (MP_TOPICS as readonly string[]).includes(value);
}

/** The topic: query `type` (Webhooks) or `topic`, else the body's `type`. Never trusted for money. */
function readTopic(url: URL, raw: string): string | null {
  const fromQuery = url.searchParams.get("type") ?? url.searchParams.get("topic");
  if (fromQuery) return fromQuery;
  try {
    const body = JSON.parse(raw) as { type?: unknown };
    return typeof body.type === "string" ? body.type : null;
  } catch {
    return null;
  }
}

function log(level: "warn" | "error", message: string, fields: Record<string, string>): void {
  // Ids and codes only: never the token, the secret, the payload or any personal data.
  console[level](`[mp-webhook] ${message}`, JSON.stringify(fields));
}

/**
 * Mercado Pago webhook (verify_jwt=false). Requirement 1: the body is ignored; the decision
 * comes only from the objects re-fetched from the MP API and from our checkout record.
 * Requirement 2: x-signature over (data.id, x-request-id, ts). Requirements 3 and 4: one
 * private RPC per event, idempotent by payment id. The notification is marked processed in the
 * RPC's own transaction, so a 500 is reprocessed by MP's retry.
 */
export function createMpWebhookHandler(deps: MpWebhookDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  return async (req) => {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_MP_BODY_BYTES) {
      return json(413, { error: "body_too_large" });
    }
    const url = new URL(req.url);
    const dataId = url.searchParams.get("data.id");
    const requestId = req.headers.get("x-request-id");
    const signature = req.headers.get("x-signature");
    if (!dataId || !DATA_ID.test(dataId)) return json(400, { error: "missing_data_id" });
    if (!requestId || !REQUEST_ID.test(requestId))
      return json(400, { error: "missing_request_id" });
    if (!signature) return json(400, { error: "missing_signature" });

    const verified = await verifyMpSignature({
      xSignature: signature,
      xRequestId: requestId,
      dataId,
      secret: deps.secret,
      nowMs: now(),
    });
    if (!verified.ok) return json(401, { error: "invalid_signature" });

    const topic = readTopic(url, raw);
    if (!isTopic(topic)) return json(200, { received: true, ignored: true });

    let stage = "claim";
    try {
      const claim = await deps.db.mpClaimNotification(requestId, topic, dataId);
      if (claim === "duplicate") return json(200, { received: true, code: "duplicate" });

      stage = "process";
      const code = await process(topic, dataId, requestId);
      if (code.startsWith("rejected") || code === "unknown_checkout") {
        log("warn", "not applied", { topic, data_id: dataId, request_id: requestId, code });
      }
      return json(200, { received: true, code });
    } catch (error) {
      if (error instanceof MpApiError && error.kind === "not_found") {
        // Simulator / deleted object: acknowledge so MP stops retrying.
        try {
          await deps.db.mpFinishNotification(requestId, "not_found");
        } catch {
          return json(500, { error: "processing_failed" });
        }
        return json(200, { received: true, code: "not_found" });
      }
      log("error", "processing failed", {
        topic,
        data_id: dataId,
        request_id: requestId,
        stage,
        error:
          error instanceof MpApiError
            ? `${error.kind}:${error.status}`
            : error instanceof Error
              ? error.name
              : "unknown",
      });
      // 500 -> MP retries; the notification stays unprocessed and is reprocessed.
      return json(500, { error: "processing_failed" });
    }
  };

  async function finish(requestId: string, code: string): Promise<string> {
    await deps.db.mpFinishNotification(requestId, code);
    return code;
  }

  async function process(topic: Topic, dataId: string, requestId: string): Promise<string> {
    if (topic === "subscription_preapproval") {
      const pre = await deps.api.getPreapproval(dataId);
      if (pre.id !== dataId) return finish(requestId, "rejected_id");
      const result = await deps.db.processMpPreapproval(pre, deps.expect, requestId);
      return String(result.code ?? "");
    }
    if (topic === "subscription_authorized_payment") {
      const invoice = await deps.api.getAuthorizedPayment(dataId);
      if (invoice.id !== dataId) return finish(requestId, "rejected_id");
      if (!invoice.payment_id) return finish(requestId, "no_payment_yet");
      const pre = await deps.api.getPreapproval(invoice.preapproval_id);
      if (pre.id !== invoice.preapproval_id) return finish(requestId, "rejected_id");
      const payment = await deps.api.getPayment(invoice.payment_id);
      if (payment.id !== invoice.payment_id) return finish(requestId, "rejected_id");
      const result = await deps.db.processMpPayment(payment, pre, deps.expect, requestId);
      return String(result.code ?? "");
    }
    // 'payment': updates (refund / chargeback / status) of a payment already linked by its
    // invoice. A payment we have never linked is not credited ('unlinked').
    const payment = await deps.api.getPayment(dataId);
    if (payment.id !== dataId) return finish(requestId, "rejected_id");
    const result = await deps.db.processMpPayment(payment, null, deps.expect, requestId);
    return String(result.code ?? "");
  }
}
