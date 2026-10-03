import { vi } from "vitest";
import type { AuthState } from "../../shared/auth";
import type { BillingCatalogEntry } from "../../shared/billing";
import type {
  BillingBackend,
  BillingCancelResult,
  BillingFunctionResult,
  BillingSnapshot,
} from "./billing-backend";

/** Test doubles for main/billing (imported by *.test.ts only). */

export const SECRET_CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_SECRET_session";
export const SECRET_PORTAL_URL = "https://billing.stripe.com/p/session/test_SECRET_portal";
export const SECRET_MP_URL =
  "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=SECRET_preapproval";

/** get_billing_catalog() after L1c with the Stripe DB flag off: Starter via Mercado Pago only. */
export const MP_STARTER: BillingCatalogEntry = {
  plan: "starter",
  name: "Starter",
  monthlyCredits: 10000,
  provider: "mercadopago",
  currency: "BRL",
  amountMinor: 4990,
  sortOrder: 1,
};
/** The extra row the catalog returns once private.billing_settings.stripe_enabled is on. */
export const STRIPE_STARTER: BillingCatalogEntry = {
  ...MP_STARTER,
  provider: "stripe",
  currency: "USD",
  amountMinor: 900,
};

export const USER_ID = "11111111-1111-4111-8111-111111111111";

export function authState(signedIn: boolean, id = USER_ID): AuthState {
  return {
    status: signedIn ? "signed-in" : "signed-out",
    user: signedIn
      ? {
          id,
          email: "ana@example.com",
          displayName: "Ana",
          avatarUrl: null,
          emailConfirmed: true,
          provider: "email",
        }
      : null,
    persistence: "encrypted",
    oauthProviders: [],
    pendingProvider: null,
    notice: null,
    error: null,
  };
}

export function createFakeAuth(initial: AuthState) {
  let state = initial;
  const listeners = new Set<(state: AuthState) => void>();
  return {
    getState: () => state,
    onStateChange: (listener: (state: AuthState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: AuthState) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

export function snapshot(overrides: Partial<BillingSnapshot> = {}): BillingSnapshot {
  return {
    plans: [
      { plan: "free", name: "Free", priceUsdCents: 0, monthlyCredits: 1000, purchasable: false },
      {
        plan: "starter",
        name: "Starter",
        priceUsdCents: 900,
        monthlyCredits: 10000,
        purchasable: true,
      },
      { plan: "pro", name: "Pro", priceUsdCents: 2000, monthlyCredits: 25000, purchasable: true },
    ],
    catalog: [MP_STARTER],
    subscription: null,
    wallet: { balance: 1000, reserved: 0, planAllowance: 1000, periodEnd: null },
    ...overrides,
  };
}

export function createFakeBillingBackend() {
  const backend = {
    fetchBilling: vi.fn(async (_userId: string) => snapshot()),
    createBillingSession: vi.fn(
      async (fn: string, _body: Record<string, string>): Promise<BillingFunctionResult> => ({
        ok: true,
        url:
          fn === "mp-checkout"
            ? SECRET_MP_URL
            : fn === "create-checkout-session"
              ? SECRET_CHECKOUT_URL
              : SECRET_PORTAL_URL,
      }),
    ),
    cancelSubscription: vi.fn(
      async (): Promise<BillingCancelResult> => ({ ok: true, code: "canceled" }),
    ),
  } satisfies BillingBackend;
  return backend;
}

/** Never handed to billing code; asserted absent from IPC payloads. */
export const SECRET_ACCESS_TOKEN_IN_BILLING = "access-token-SECRET-a1";
