/**
 * Pure forwarding logic for /billing/return (imported by return.js and forward.test.js).
 *
 * The destination is ALWAYS the fixed modus://billing/return. Nothing from the query is ever
 * used as a destination: only `modus_billing` (enum) and `session_id` (Checkout Session id
 * format) are copied, after validation, as query parameters of that fixed URL.
 */
export const BILLING_RETURN_DEEP_LINK = "modus://billing/return";

export const BILLING_STATUSES = Object.freeze(["success", "cancel", "portal"]);

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]+$/;
const MAX_SESSION_ID_LENGTH = 255;

/** Copy shown on the page per status (set with textContent, never innerHTML). */
export const STATUS_TITLES = Object.freeze({
  success: "Payment received",
  cancel: "Checkout cancelled",
  portal: "Billing updated",
});

/**
 * @param {string} search location.search (with or without the leading "?")
 * @returns {{ target: string, status: string | null }}
 */
export function buildBillingForward(search) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const out = new URLSearchParams();
  const rawStatus = params.get("modus_billing");
  const status = rawStatus !== null && BILLING_STATUSES.includes(rawStatus) ? rawStatus : null;
  if (status) out.set("status", status);
  const sessionId = params.get("session_id");
  if (
    sessionId !== null &&
    sessionId.length <= MAX_SESSION_ID_LENGTH &&
    SESSION_ID.test(sessionId)
  ) {
    out.set("session_id", sessionId);
  }
  const query = out.toString();
  return {
    target: query ? `${BILLING_RETURN_DEEP_LINK}?${query}` : BILLING_RETURN_DEEP_LINK,
    status,
  };
}
