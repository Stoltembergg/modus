/**
 * Minimal Mercado Pago REST client (B6a): fixed base URL, bearer access token, per-call
 * timeout, no redirects, no retries. Responses are normalized into small typed objects
 * (amounts in integer minor units) and the raw payload is dropped; nothing here logs.
 */
export const MP_API_BASE = "https://api.mercadopago.com";
export const MP_TIMEOUT_MS = 8_000;

const NUMERIC_ID = /^[0-9]{1,18}$/;
const PREAPPROVAL_ID = /^[A-Za-z0-9]{1,64}$/;

export class MpApiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: "not_found" | "http" | "timeout" | "network" | "invalid_response",
  ) {
    super(`mercadopago ${kind}${status ? ` ${status}` : ""}`);
    this.name = "MpApiError";
  }
}

export type MpPreapproval = {
  id: string;
  status: string;
  external_reference: string | null;
  collector_id: string | null;
  amount_minor: number;
  currency: string | null;
  next_payment_date: string | null;
  init_point: string | null;
};

export type MpAuthorizedPayment = {
  id: string;
  preapproval_id: string;
  payment_id: string | null;
};

export type MpPayment = {
  id: string;
  status: string;
  status_detail: string | null;
  amount_minor: number;
  refunded_minor: number;
  live_mode: boolean | null;
  collector_id: string | null;
  currency: string | null;
  external_reference: string | null;
};

export type CreatePreapprovalInput = {
  reason: string;
  externalReference: string;
  payerEmail: string;
  amountMinor: number;
  currency: string;
  backUrl: string;
};

export interface MpApi {
  getPreapproval(id: string): Promise<MpPreapproval>;
  getAuthorizedPayment(id: string): Promise<MpAuthorizedPayment>;
  getPayment(id: string): Promise<MpPayment>;
  /** POST /preapproval with X-Idempotency-Key (the checkout id). */
  createPreapproval(input: CreatePreapprovalInput, idempotencyKey: string): Promise<MpPreapproval>;
  /** L1e: PUT /preapproval/{id} { status: "canceled" } (irreversible on Mercado Pago's side). */
  cancelPreapproval(id: string): Promise<MpPreapproval>;
}

/**
 * Mercado Pago documents the preapproval status as "canceled"; "cancelled" is accepted as the
 * same value so a spelling variant can never leave a cancelled subscription live here.
 */
export function normalizePreapprovalStatus(status: string): string {
  return status.toLowerCase() === "cancelled" ? "canceled" : status;
}

function invalid(): never {
  throw new MpApiError(0, "invalid_response");
}

/** A money amount (number or numeric string, at most 2 decimals) in integer minor units. */
export function toMinor(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n < 0) invalid();
  const minor = Math.round(n * 100);
  if (Math.abs(n * 100 - minor) > 1e-6 || !Number.isSafeInteger(minor)) invalid();
  return minor;
}

/** Ids come as numbers or strings depending on the endpoint; always strings here. */
export function idString(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function optString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

export function normalizePreapproval(raw: unknown): MpPreapproval {
  const body = obj(raw);
  const recurring = obj(body.auto_recurring);
  const id = optString(body.id);
  const status = optString(body.status);
  if (!id || !PREAPPROVAL_ID.test(id) || !status) invalid();
  const next = optString(body.next_payment_date);
  return {
    id,
    status: normalizePreapprovalStatus(status),
    external_reference: idString(body.external_reference),
    collector_id: idString(body.collector_id),
    amount_minor: toMinor(recurring.transaction_amount),
    currency: optString(recurring.currency_id),
    next_payment_date: next && !Number.isNaN(Date.parse(next)) ? next : null,
    init_point: optString(body.init_point),
  };
}

export function normalizeAuthorizedPayment(raw: unknown): MpAuthorizedPayment {
  const body = obj(raw);
  const id = idString(body.id);
  const preapprovalId = optString(body.preapproval_id);
  if (!id || !NUMERIC_ID.test(id) || !preapprovalId || !PREAPPROVAL_ID.test(preapprovalId))
    invalid();
  const payment =
    body.payment && typeof body.payment === "object"
      ? (body.payment as Record<string, unknown>)
      : {};
  const paymentId = idString(payment.id);
  if (paymentId !== null && !NUMERIC_ID.test(paymentId)) invalid();
  return { id, preapproval_id: preapprovalId, payment_id: paymentId };
}

export function normalizePayment(raw: unknown): MpPayment {
  const body = obj(raw);
  const id = idString(body.id);
  const status = optString(body.status);
  if (!id || !NUMERIC_ID.test(id) || !status) invalid();
  return {
    id,
    status,
    status_detail: optString(body.status_detail),
    amount_minor: toMinor(body.transaction_amount),
    refunded_minor:
      body.transaction_amount_refunded === undefined || body.transaction_amount_refunded === null
        ? 0
        : toMinor(body.transaction_amount_refunded),
    live_mode: typeof body.live_mode === "boolean" ? body.live_mode : null,
    collector_id: idString(body.collector_id),
    currency: optString(body.currency_id),
    external_reference: idString(body.external_reference),
  };
}

export function createMpApi(
  accessToken: string,
  {
    fetchImpl = fetch,
    timeoutMs = MP_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): MpApi {
  async function call(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
    let response: Response;
    try {
      response = await fetchImpl(`${MP_API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new MpApiError(
        0,
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      );
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new MpApiError(404, "not_found");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MpApiError(response.status, "http");
    }
    try {
      return await response.json();
    } catch {
      throw new MpApiError(response.status, "invalid_response");
    }
  }

  return {
    getPreapproval: async (id) => {
      if (!PREAPPROVAL_ID.test(id)) throw new MpApiError(404, "not_found");
      return normalizePreapproval(await call("GET", `/preapproval/${id}`));
    },
    getAuthorizedPayment: async (id) => {
      if (!NUMERIC_ID.test(id)) throw new MpApiError(404, "not_found");
      return normalizeAuthorizedPayment(await call("GET", `/authorized_payments/${id}`));
    },
    getPayment: async (id) => {
      if (!NUMERIC_ID.test(id)) throw new MpApiError(404, "not_found");
      return normalizePayment(await call("GET", `/v1/payments/${id}`));
    },
    createPreapproval: async (input, idempotencyKey) =>
      normalizePreapproval(
        await call(
          "POST",
          "/preapproval",
          {
            reason: input.reason,
            external_reference: input.externalReference,
            payer_email: input.payerEmail,
            auto_recurring: {
              frequency: 1,
              frequency_type: "months",
              transaction_amount: input.amountMinor / 100,
              currency_id: input.currency,
            },
            back_url: input.backUrl,
            status: "pending",
          },
          idempotencyKey,
        ),
      ),
    cancelPreapproval: async (id) => {
      if (!PREAPPROVAL_ID.test(id)) throw new MpApiError(404, "not_found");
      return normalizePreapproval(await call("PUT", `/preapproval/${id}`, { status: "canceled" }));
    },
  };
}
