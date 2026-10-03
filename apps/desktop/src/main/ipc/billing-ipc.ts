import { z } from "zod";
import {
  BILLING_PLAN_KEY_PATTERN,
  BILLING_PROVIDERS,
  type BillingCheckoutInput,
  type BillingProvider,
  type BillingState,
} from "../../shared/billing";
import { IPC_CHANNELS } from "./channels";
import { parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

export type BillingIpcService = {
  getState(): BillingState;
  refresh(): Promise<BillingState>;
  startCheckout(plan: string, provider?: BillingProvider): Promise<BillingState>;
  openPortal(): Promise<BillingState>;
  cancelSubscription(): Promise<BillingState>;
};

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

const billingNoInputSchema = z.undefined();

/** Only a plan key (+ provider): the Edge Function maps it to the price server-side. */
export const billingCheckoutSchema = z
  .object({
    plan: z.string().regex(BILLING_PLAN_KEY_PATTERN),
    provider: z.enum(BILLING_PROVIDERS as [BillingProvider, ...BillingProvider[]]).optional(),
  })
  .strict() as z.ZodType<BillingCheckoutInput>;

/**
 * L1e: cancelling takes nothing from the renderer (no subscription / preapproval id): nothing or
 * an empty object, any key is rejected. mp-cancel finds the subscription from the JWT.
 */
export const billingCancelSchema = z.object({}).strict().optional();

/**
 * Billing IPC: every reply is a BillingState (display data only). The access token, Stripe ids
 * and Checkout / Portal URLs stay in main; billing-ipc.test.ts asserts that on every payload.
 */
export function registerBillingIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: BillingIpcService,
): void {
  const handle = <T>(channel: string, schema: z.ZodType<T>, run: (input: T) => unknown) => {
    ipcMain.handle(channel, (event, input) => {
      assertTrustedSender(event);
      return run(parseIpcInput(schema, input, channel));
    });
  };
  handle(IPC_CHANNELS.billingGetState, billingNoInputSchema, () => service.getState());
  handle(IPC_CHANNELS.billingRefresh, billingNoInputSchema, () => service.refresh());
  handle(IPC_CHANNELS.billingCheckout, billingCheckoutSchema, (input) =>
    service.startCheckout(input.plan, input.provider),
  );
  handle(IPC_CHANNELS.billingPortal, billingNoInputSchema, () => service.openPortal());
  handle(IPC_CHANNELS.billingCancel, billingCancelSchema, () => service.cancelSubscription());
}
