import type { AuthState } from "../../shared/auth";
import {
  BILLING_PLAN_KEY_PATTERN,
  type BillingReturnStatus,
  type BillingState,
} from "../../shared/billing";
import { AuthBackendError } from "../auth/auth-backend";
import {
  type BillingBackend,
  CHECKOUT_URL_PREFIX,
  isStripeHostedUrl,
  PORTAL_URL_PREFIX,
} from "./billing-backend";

export interface BillingService {
  getState(): BillingState;
  refresh(): Promise<BillingState>;
  /** Opens Stripe Checkout for a plan key (the Function maps it to the price). */
  startCheckout(plan: string): Promise<BillingState>;
  /** Opens the Stripe Customer Portal (upgrade / downgrade / cancel / payment method). */
  openPortal(): Promise<BillingState>;
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
  setTimer?(run: () => void, ms: number): { cancel(): void };
};

const ERRORS: Record<string, string> = {
  already_subscribed: "You already have a subscription. Use Manage billing to change plans.",
  no_billing_account: "No billing account yet. Choose a plan first.",
  unknown_plan: "This plan is not available.",
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
    subscription: null,
    wallet: null,
    currentPlan: "free",
    pending: null,
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

  async function openSession(kind: "checkout" | "portal", plan?: string): Promise<BillingState> {
    if (!backend || !signedInUser()) {
      return setState({ error: ERRORS.unauthorized ?? GENERIC_ERROR });
    }
    try {
      const result =
        kind === "checkout"
          ? await backend.createBillingSession("create-checkout-session", { plan: plan ?? "" })
          : await backend.createBillingSession("create-portal-session", {});
      if (!result.ok)
        return setState({ pending: null, error: ERRORS[result.code] ?? GENERIC_ERROR });
      const prefix = kind === "checkout" ? CHECKOUT_URL_PREFIX : PORTAL_URL_PREFIX;
      if (!isStripeHostedUrl(result.url, prefix)) {
        return setState({ pending: null, error: GENERIC_ERROR });
      }
      await deps.openExternal(result.url);
      return setState({ pending: kind, lastReturn: null, error: null });
    } catch (error) {
      return setState({ pending: null, error: userFacing(error) });
    }
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

    startCheckout(plan) {
      if (typeof plan !== "string" || !BILLING_PLAN_KEY_PATTERN.test(plan)) {
        return Promise.resolve(setState({ error: ERRORS.unknown_plan ?? GENERIC_ERROR }));
      }
      const known = state.plans.find((entry) => entry.plan === plan);
      if (state.status === "ready" && !known?.purchasable) {
        return Promise.resolve(setState({ error: ERRORS.unknown_plan ?? GENERIC_ERROR }));
      }
      return openSession("checkout", plan);
    },

    openPortal() {
      return openSession("portal");
    },

    async handleReturn(status) {
      setState({ pending: null, lastReturn: status });
      cancelTimers();
      const run = generation;
      for (const delay of returnDelays) {
        const timer = setTimer(() => {
          timers.delete(timer);
          if (run === generation) void refresh();
        }, delay);
        timers.add(timer);
      }
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
