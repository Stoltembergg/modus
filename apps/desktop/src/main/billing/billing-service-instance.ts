import { BrowserWindow, shell } from "electron";
import type { BillingState } from "../../shared/billing";
import { getAuthService, getSupabaseBillingBackend } from "../auth/auth-service-instance";
import type { BillingIpcService } from "../ipc/billing-ipc";
import { IPC_CHANNELS } from "../ipc/channels";
import { type BillingService, createBillingService } from "./billing-service";

let service: BillingService | undefined;

function broadcast(state: BillingState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.billingStateEvent, state);
  }
}

export function getBillingService(): BillingService {
  if (service) return service;
  service = createBillingService({
    auth: getAuthService(),
    backend: getSupabaseBillingBackend(),
    openExternal: (url) => shell.openExternal(url),
  });
  service.onStateChange(broadcast);
  return service;
}

export const billingIpcService: BillingIpcService = {
  getState: () => getBillingService().getState(),
  refresh: () => getBillingService().refresh(),
  startCheckout: (plan, provider) => getBillingService().startCheckout(plan, provider),
  openPortal: () => getBillingService().openPortal(),
};

export function shutdownBillingService(): void {
  service?.dispose();
  service = undefined;
}
