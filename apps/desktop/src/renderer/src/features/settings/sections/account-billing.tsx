import { IconCreditCard, IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { BillingPlan, BillingState } from "../../../../../shared/billing";
import { ReadOnlyPill, SettingsList, SettingsRow, SettingsSection } from "../settings-layout";

const SECONDARY_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40";
const PRIMARY_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40";

const RETURN_NOTICES: Record<string, string> = {
  success: "Payment received. Your plan updates as soon as Stripe confirms it.",
  cancel: "Checkout was cancelled. Nothing was charged.",
  portal: "Back from billing. Showing the latest plan.",
};

export function formatCredits(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPrice(cents: number): string {
  return cents === 0 ? "Free" : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}/mo`;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

type ViewProps = {
  state: BillingState | undefined;
  busy: boolean;
  onCheckout(plan: string): void;
  onPortal(): void;
  onRefresh(): void;
};

/** Presentational: everything comes from BillingState (display data only). */
export function BillingSectionView({ state, busy, onCheckout, onPortal, onRefresh }: ViewProps) {
  if (!state || state.status === "unavailable" || state.status === "signed-out") return null;
  const current: BillingPlan | undefined = state.plans.find(
    (plan) => plan.plan === state.currentPlan,
  );
  const subscribed = Boolean(state.subscription);
  const renews = formatDate(state.subscription?.currentPeriodEnd ?? null);
  const purchasable = state.plans.filter((plan) => plan.purchasable);
  const loading = state.status === "loading";

  return (
    <SettingsSection
      description="Plans are paid through Stripe in your browser. Upgrades add the difference in credits right away; downgrades apply at the end of the period."
      title="Plan & credits"
    >
      {state.error ? <p className="mb-3 text-danger text-xs">{state.error}</p> : null}
      {state.lastReturn && RETURN_NOTICES[state.lastReturn] ? (
        <p className="mb-3 text-success text-xs">{RETURN_NOTICES[state.lastReturn]}</p>
      ) : null}
      {state.pending ? (
        <p className="mb-3 text-fg-muted text-xs">
          Finish in your browser, then come back to Modus.
        </p>
      ) : null}
      <SettingsList>
        <SettingsRow
          control={
            <div className="flex items-center gap-2">
              <ReadOnlyPill>
                {loading ? "Loading…" : (current?.name ?? state.currentPlan)}
              </ReadOnlyPill>
              <button
                aria-label="Refresh plan"
                className={SECONDARY_BUTTON}
                disabled={busy || loading}
                onClick={onRefresh}
                type="button"
              >
                <IconRefresh size={14} stroke={1.7} />
              </button>
            </div>
          }
          description={
            subscribed
              ? `${state.subscription?.status ?? ""}${
                  state.subscription?.cancelAtPeriodEnd
                    ? renews
                      ? ` · ends ${renews}`
                      : " · ends at period end"
                    : renews
                      ? ` · renews ${renews}`
                      : ""
                }`
              : "No paid subscription."
          }
          title="Current plan"
        />
        <SettingsRow
          control={<ReadOnlyPill>{formatCredits(state.wallet?.balance ?? 0)}</ReadOnlyPill>}
          description={
            state.wallet
              ? `Monthly allowance ${formatCredits(state.wallet.planAllowance)}${
                  state.wallet.reserved > 0
                    ? ` · ${formatCredits(state.wallet.reserved)} reserved`
                    : ""
                }`
              : "Credits appear after your email is confirmed."
          }
          title="Credits"
        />
        {subscribed ? (
          <SettingsRow
            control={
              <button
                className={PRIMARY_BUTTON}
                disabled={busy || loading}
                onClick={onPortal}
                type="button"
              >
                <IconExternalLink size={13} stroke={2} />
                Manage billing
              </button>
            }
            description="Upgrade, downgrade, cancel or update the payment method in Stripe."
            title="Change plan"
          />
        ) : (
          purchasable.map((plan) => (
            <SettingsRow
              control={
                <button
                  className={PRIMARY_BUTTON}
                  disabled={busy || loading || Boolean(state.pending)}
                  onClick={() => onCheckout(plan.plan)}
                  type="button"
                >
                  <IconCreditCard size={13} stroke={2} />
                  {`Choose ${plan.name}`}
                </button>
              }
              description={`${formatCredits(plan.monthlyCredits)} credits per month`}
              key={plan.plan}
              title={`${plan.name} · ${formatPrice(plan.priceUsdCents)}`}
            />
          ))
        )}
      </SettingsList>
    </SettingsSection>
  );
}

export function AccountBillingSection() {
  const [state, setState] = useState<BillingState | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const billing = window.modus?.billing;
    if (!billing) return;
    let active = true;
    void billing
      .getState()
      .then((next: BillingState) => {
        if (active) setState(next);
      })
      .catch(() => undefined);
    const unsubscribe = billing.onStateChange((next: BillingState) => setState(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function run(action: () => Promise<BillingState>): Promise<void> {
    setBusy(true);
    try {
      setState(await action());
    } catch {
      // Main already reports errors through BillingState.
    } finally {
      setBusy(false);
    }
  }

  return (
    <BillingSectionView
      busy={busy}
      onCheckout={(plan) => void run(() => window.modus.billing.checkout({ plan }))}
      onPortal={() => void run(() => window.modus.billing.openPortal())}
      onRefresh={() => void run(() => window.modus.billing.refresh())}
      state={state}
    />
  );
}
