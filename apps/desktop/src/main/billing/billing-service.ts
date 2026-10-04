import type { AuthState } from "../../shared/auth";
import {
  BILLING_PLAN_KEY_PATTERN,
  type BillingProvider,
  type BillingReturnStatus,
  type BillingState,
  isBillingProvider,
  isCreditPackId,
} from "../../shared/billing";
import { AuthBackendError } from "../auth/auth-backend";
import {
  type BillingBackend,
  CHECKOUT_FUNCTIONS,
  CHECKOUT_URL_PREFIXES,
  isStripeHostedUrl,
  PORTAL_URL_PREFIX,
} from "./billing-backend";

export interface BillingService {
  getState(): BillingState;
  refresh(): Promise<BillingState>;
  /**
   * Opens the provider's checkout (Mercado Pago by default) for a plan key the catalog offers
   * with that provider; the Function maps it to the price.
   */
  startCheckout(plan: string, provider?: BillingProvider): Promise<BillingState>;
  /**
   * L5b: opens Mercado Pago Checkout Pro (Pix or card) for a credit pack the catalog offers.
   * Only the pack id goes to mp-buy-credits; credits arrive with the payment webhook.
   */
  buyCredits(packId: string): Promise<BillingState>;
  /** Opens the Stripe Customer Portal (upgrade / downgrade / cancel / payment method). */
  openPortal(): Promise<BillingState>;
  /**
   * L1e: asks mp-cancel to cancel the user's own live Mercado Pago subscription (no id crosses
   * IPC or leaves main), then refreshes now and again while the webhook catches up. The
   * subscription (and so the blocked Subscribe button) stays until the status leaves the live set.
   */
  cancelSubscription(): Promise<BillingState>;
  /** modus://billing/return: refresh now and again while the webhook catches up. */
  handleReturn(status: BillingReturnStatus | null): Promise<BillingState>;
  onStateChange(listener: (state: BillingState) => void): () => void;
  dispose(): void;
}

type AuthSource = {
  getState(): AuthState;
  onStateChange(listener: (state: AuthState) => void): () => void;
};

type Deps = {
  auth: AuthSource;
  backend: BillingBackend | undefined;
  openExternal(url: string): Promise<void>;
  /** Extra refreshes after a return (webhook latency). */
  returnRefreshDelaysMs?: number[];
  /** Extra refreshes after a cancel request (webhook latency). */
  cancelRefreshDelaysMs?: number[];
  setTimer?(run: () => void, ms: number): { cancel(): void };
};

const ERRORS: Record<string, string> = {
  already_subscribed: "You already have a subscription.",
  checkout_conflict: "A checkout is already being created. Try again in a moment.",
  cancel_not_available: "There is no Mercado Pago subscription to cancel.",
  cancel_grace_active:
    "Your cancelled plan stays active until the end of the period you paid for. You can subscribe again after that.",
  email_required: "Add an email address to your account before subscribing.",
  mercadopago_unavailable: "Mercado Pago is unavailable right now. Try again in a few minutes.",
  stripe_disabled: "Card payments through Stripe are turned off right now.",
  no_billing_account: "No billing account yet. Choose a plan first.",
  unknown_plan: "This plan is not available.",
  unknown_pack: "This credit pack is not available.",
  account_blocked:
    "Purchases are blocked on this account after a payment dispute. Contact support.",
  subscriptions_disabled: "Subscriptions are not available right now. Buy a credit pack instead.",
  purchase_conflict: "This purchase is already being set up. Try again in a moment.",
  unauthorized: "Sign in again to manage billing.",
};
const GENERIC_ERROR = "Billing is unavailable right now. Try again.";
const NETWORK_ERROR = "Couldn't reach the billing service. Check your connection and try again.";

function defaultTimer(run: () => void, ms: number) {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

function emptyState(status: BillingState["status"]): BillingState {
  return {
    status,
    plans: [],
    catalog: null,
    packs: null,
    subscription: null,
    wallet: null,
    currentPlan: "free",
    pending: null,
    cancelling: false,
    lastReturn: null,
    error: null,
  };
}

function userFacing(error: unknown): string {
  if (error instanceof AuthBackendError && error.kind === "network") return NETWORK_ERROR;
  return GENERIC_ERROR;
}

export function createBillingService(deps: Deps): BillingService {
  const { auth, backend } = deps;
  const setTimer = deps.setTimer ?? defaultTimer;
  const returnDelays = deps.returnRefreshDelaysMs ?? [4_000, 12_000];
  const cancelDelays = deps.cancelRefreshDelaysMs ?? [3_000, 10_000, 30_000];
  const listeners = new Set<(state: BillingState) => void>();
  const timers = new Set<{ cancel(): void }>();
  let state = emptyState(backend ? "signed-out" : "unavailable");
  let userId: string | null = null;
  /** Bumped on every user change so a late fetch cannot show another user's billing. */
  let generation = 0;

  function snapshot(): BillingState {
    return structuredClone(state);
  }

  function setState(patch: Partial<BillingState>): BillingState {
    state = { ...state, ...patch };
    for (const notify of listeners) notify(snapshot());
    return snapshot();
  }

  function cancelTimers(): void {
    for (const timer of timers) timer.cancel();
    timers.clear();
  }

  function signedInUser(): string | null {
    const current = auth.getState();
    return current.status === "signed-in" && current.user ? current.user.id : null;
  }

  async function refresh(): Promise<BillingState> {
    if (!backend) return setState(emptyState("unavailable"));
    const id = signedInUser();
    if (!id) return setState(emptyState("signed-out"));
    const run = generation;
    if (state.status !== "ready") setState({ status: "loading", error: null });
    try {
      const data = await backend.fetchBilling(id);
      if (run !== generation || signedInUser() !== id) return snapshot();
      return setState({
        status: "ready",
        plans: data.plans,
        catalog: data.catalog,
        packs: data.packs,
        subscription: data.subscription,
        wallet: data.wallet,
        currentPlan: data.subscription?.plan ?? "free",
        error: null,
      });
    } catch (error) {
      if (run !== generation) return snapshot();
      return setState({
        status: state.status === "ready" ? "ready" : "error",
        error: userFacing(error),
      });
    }
  }

  async function openSession(
    kind: "checkout" | "portal",
    plan?: string,
    provider: BillingProvider = "mercadopago",
  ): Promise<BillingState> {
    if (!backend || !signedInUser()) {
      return setState({ error: ERRORS.unauthorized ?? GENERIC_ERROR });
    }
    try {
      const result =
        kind === "checkout"
          ? await backend.createBillingSession(CHECKOUT_FUNCTIONS[provider], { plan: plan ?? "" })
          : await backend.createBillingSession("create-portal-session", {});
      if (!result.ok)
        return setState({ pending: null, error: ERRORS[result.code] ?? GENERIC_ERROR });
      const prefix = kind === "checkout" ? CHECKOUT_URL_PREFIXES[provider] : PORTAL_URL_PREFIX;
      if (!isStripeHostedUrl(result.url, prefix)) {
        return setState({ pending: null, error: GENERIC_ERROR });
      }
      await deps.openExternal(result.url);
      return setState({ pending: kind, lastReturn: null, error: null });
    } catch (error) {
      return setState({ pending: null, error: userFacing(error) });
    }
  }

  function scheduleRefreshes(delays: number[]): void {
    const run = generation;
    for (const delay of delays) {
      const timer = setTimer(() => {
        timers.delete(timer);
        if (run === generation) void refresh();
      }, delay);
      timers.add(timer);
    }
  }

  async function cancelSubscription(): Promise<BillingState> {
    if (!backend || !signedInUser()) {
      return setState({ error: ERRORS.unauthorized ?? GENERIC_ERROR });
    }
    if (state.cancelling) return snapshot();
    if (
      state.status !== "ready" ||
      state.subscription?.provider !== "mercadopago" ||
      // L1g: a cancelled row kept until current_period_end has nothing left to cancel.
      state.subscription.status === "canceled"
    ) {
      return setState({ error: ERRORS.cancel_not_available ?? GENERIC_ERROR });
    }
    const run = generation;
    setState({ cancelling: true, error: null });
    let error: string | null = null;
    try {
      const result = await backend.cancelSubscription();
      if (!result.ok) error = ERRORS[result.code] ?? GENERIC_ERROR;
    } catch (caught) {
      error = userFacing(caught);
    }
    if (run !== generation) return snapshot();
    if (error) return setState({ cancelling: false, error });
    // The final status comes from the server (webhook / confirmed re-read), never from here.
    cancelTimers();
    scheduleRefreshes(cancelDelays);
    await refresh();
    if (run !== generation) return snapshot();
    return setState({ cancelling: false });
  }

  function onAuth(next: AuthState): void {
    const id = next.status === "signed-in" && next.user ? next.user.id : null;
    if (id === userId) return;
    userId = id;
    generation += 1;
    cancelTimers();
    if (!id) {
      setState(emptyState(backend ? "signed-out" : "unavailable"));
      return;
    }
    setState(emptyState("loading"));
    void refresh();
  }
  const unsubscribeAuth = auth.onStateChange(onAuth);
  onAuth(auth.getState());

  return {
    getState: snapshot,
    refresh,

    startCheckout(plan, provider = "mercadopago") {
      if (
        typeof plan !== "string" ||
        !BILLING_PLAN_KEY_PATTERN.test(plan) ||
        !isBillingProvider(provider)
      ) {
        return Promise.resolve(setState({ error: ERRORS.unknown_plan ?? GENERIC_ERROR }));
      }
      // Only what the catalog currently sells (Stripe only while its DB flag is on).
      const offered = state.catalog?.some(
        (entry) => entry.plan === plan && entry.provider === provider,
      );
      if (state.status !== "ready" || !offered) {
        return Promise.resolve(setState({ error: ERRORS.unknown_plan ?? GENERIC_ERROR }));
      }
      if (state.subscription) {
        // L1g: a cancelled Mercado Pago row kept until current_period_end (mp-checkout refuses
        // it too, with cancel_grace_active).
        const code =
          state.subscription.status === "canceled" ? "cancel_grace_active" : "already_subscribed";
        return Promise.resolve(setState({ error: ERRORS[code] ?? GENERIC_ERROR }));
      }
      return openSession("checkout", plan, provider);
    },

    async buyCredits(packId) {
      const unavailable = () => setState({ error: ERRORS.unknown_pack ?? GENERIC_ERROR });
      if (!isCreditPackId(packId)) return unavailable();
      if (!backend || !signedInUser()) {
        return setState({ error: ERRORS.unauthorized ?? GENERIC_ERROR });
      }
      // Only what the catalog currently sells.
      if (state.status !== "ready" || !state.packs?.some((pack) => pack.packId === packId)) {
        return unavailable();
      }
      try {
        const result = await backend.createBillingSession("mp-buy-credits", { packId });
        if (!result.ok)
          return setState({ pending: null, error: ERRORS[result.code] ?? GENERIC_ERROR });
        if (!isStripeHostedUrl(result.url, CHECKOUT_URL_PREFIXES.mercadopago)) {
          return setState({ pending: null, error: GENERIC_ERROR });
        }
        await deps.openExternal(result.url);
        return setState({ pending: "checkout", lastReturn: null, error: null });
      } catch (error) {
        return setState({ pending: null, error: userFacing(error) });
      }
    },

    openPortal() {
      return openSession("portal");
    },

    cancelSubscription,

    async handleReturn(status) {
      setState({ pending: null, lastReturn: status });
      cancelTimers();
      scheduleRefreshes(returnDelays);
      return await refresh();
    },

    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      cancelTimers();
      unsubscribeAuth();
      listeners.clear();
    },
  };
}
