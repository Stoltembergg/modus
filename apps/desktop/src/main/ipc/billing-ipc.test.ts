import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authState,
  createFakeAuth,
  createFakeBillingBackend,
  SECRET_ACCESS_TOKEN_IN_BILLING,
} from "../billing/billing.test-helpers";
import { createBillingService } from "../billing/billing-service";
import { registerBillingIpcHandlers } from "./billing-ipc";
import {
  assertTrustedSender,
  registerTrustedSender,
  type TrustedSenderEvent,
} from "./trusted-sender";

const BILLING_CHANNELS = [
  "billing:get-state",
  "billing:refresh",
  "billing:checkout",
  "billing:portal",
];

type Handler = (event: TrustedSenderEvent, input?: unknown) => unknown;

describe("billing IPC", () => {
  let unregister: (() => void) | undefined;

  afterEach(() => {
    unregister?.();
  });

  function setup() {
    const backend = createFakeBillingBackend();
    const openExternal = vi.fn(async (_url: string) => undefined);
    const service = createBillingService({
      auth: createFakeAuth(authState(true)),
      backend,
      openExternal,
      setTimer: () => ({ cancel: () => undefined }),
    });
    const broadcasts: unknown[] = [];
    service.onStateChange((state) => broadcasts.push(structuredClone(state)));
    const handlers = new Map<string, Handler>();
    registerBillingIpcHandlers(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      assertTrustedSender,
      service,
    );
    const sender = { mainFrame: { url: "file:///index.html" } };
    unregister = registerTrustedSender(sender, "file:///index.html");
    const trusted = { sender, senderFrame: sender.mainFrame };
    const call = async (channel: string, input?: unknown) =>
      structuredClone(await handlers.get(channel)?.(trusted, input));
    return { backend, openExternal, handlers, broadcasts, call };
  }

  it("registers every billing command and rejects untrusted senders", () => {
    const { handlers, backend } = setup();
    expect([...handlers.keys()].sort()).toEqual([...BILLING_CHANNELS].sort());
    const event = { senderFrame: { url: "https://attacker.invalid/" } };
    for (const channel of BILLING_CHANNELS) {
      expect(() => handlers.get(channel)?.(event, { plan: "pro" })).toThrow(/untrusted/);
    }
    expect(backend.createBillingSession).not.toHaveBeenCalled();
  });

  it("accepts only {plan, provider?} for checkout: no price, customer, user id or URL", async () => {
    const { call, backend } = setup();
    for (const input of [
      { plan: "pro", price: "price_123" },
      { plan: "pro", customer: "cus_123" },
      { plan: "pro", userId: "11111111-1111-4111-8111-111111111111" },
      { plan: "pro", successUrl: "https://evil.example" },
      { plan: "PRO" },
      { plan: "pro", provider: "paypal" },
      { plan: "pro", provider: "" },
      { price: "price_123" },
      undefined,
    ]) {
      await expect(call("billing:checkout", input)).rejects.toThrow(/Invalid IPC payload/);
    }
    await expect(call("billing:portal", { customer: "cus_123" })).rejects.toThrow();
    await expect(call("billing:refresh", { force: true })).rejects.toThrow();
    expect(backend.createBillingSession).not.toHaveBeenCalled();
  });

  it("replies with display data only (no session URLs, Stripe ids or tokens)", async () => {
    const { call, broadcasts, openExternal } = setup();
    const replies = [
      await call("billing:refresh"),
      await call("billing:checkout", { plan: "starter" }),
      await call("billing:checkout", { plan: "starter", provider: "mercadopago" }),
      await call("billing:portal"),
      await call("billing:get-state"),
    ];
    expect(openExternal).toHaveBeenCalledTimes(3);
    const payload = JSON.stringify({ replies, broadcasts });
    expect(payload).not.toMatch(
      /stripe\.com|mercadopago\.com|preapproval|cs_test_|cus_|price_|sub_/,
    );
    expect(payload).not.toContain(SECRET_ACCESS_TOKEN_IN_BILLING);
    for (const reply of [...replies, ...broadcasts]) {
      expect(Object.keys(reply as object).sort()).toEqual(
        [
          "catalog",
          "currentPlan",
          "error",
          "lastReturn",
          "pending",
          "plans",
          "status",
          "subscription",
          "wallet",
        ].sort(),
      );
    }
  });
});
