import {
  getAuthService,
  getModelRouterConfig,
  modusRouterSession,
} from "../auth/auth-service-instance";
import { getBillingService } from "../billing/billing-service-instance";
import { setModusProvider } from "./model-service";
import { createModusProvider, type ModusProvider } from "./modus-provider";
import { createModusRouterStream } from "./providers/modus-router-adapter";
import { fetchModusModels } from "./providers/modus-router-models";

/** Balance refreshes after Modus calls are coalesced (a tool loop makes many calls). */
const BALANCE_REFRESH_DEBOUNCE_MS = 1_000;

let provider: ModusProvider | undefined;
let stopPlanWatch: (() => void) | undefined;

/**
 * B4b: Modus provider wiring for the app (main process). `onChanged` is the same notification
 * the remote catalog uses (model:catalog-changed), so the renderer re-reads model settings.
 */
export function startModusProvider(onChanged: () => void): void {
  if (provider) return;
  const routerUrl = () => getModelRouterConfig()?.url;
  const anonKey = () => getModelRouterConfig()?.anonKey;
  let balanceTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshBalance = () => {
    if (balanceTimer) clearTimeout(balanceTimer);
    balanceTimer = setTimeout(() => {
      balanceTimer = undefined;
      void getBillingService()
        .refresh()
        .catch(() => undefined);
    }, BALANCE_REFRESH_DEBOUNCE_MS);
    balanceTimer.unref?.();
  };
  const stream = createModusRouterStream({
    routerUrl,
    anonKey,
    session: modusRouterSession,
    onCallSettled: refreshBalance,
  });
  provider = createModusProvider({
    auth: getAuthService(),
    fetchModels: () => fetchModusModels({ routerUrl, anonKey, session: modusRouterSession }),
    stream,
    routerUrl,
    onChanged: () => {
      setModusProvider(provider);
      onChanged();
    },
  });
  setModusProvider(provider);
  // A plan change (checkout / portal) changes which models are allowed: list them again.
  let plan: string | undefined;
  stopPlanWatch = getBillingService().onStateChange((state) => {
    const next = state.status === "ready" ? state.currentPlan : undefined;
    if (next && plan && next !== plan) void provider?.reload();
    if (next) plan = next;
  });
}

export function stopModusProvider(): void {
  stopPlanWatch?.();
  stopPlanWatch = undefined;
  provider?.dispose();
  provider = undefined;
  setModusProvider(undefined);
}
