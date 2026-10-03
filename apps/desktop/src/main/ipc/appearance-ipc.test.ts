import { describe, expect, it, vi } from "vitest";
import { registerAppearanceIpcHandlers } from "./appearance-ipc";
import type { TrustedSenderEvent } from "./trusted-sender";

function register() {
  const handlers = new Map<string, (event: TrustedSenderEvent, input?: unknown) => unknown>();
  const appearance = {
    getState: vi.fn(() => ({ glass: true })),
    set: vi.fn(() => ({ glass: false })),
  };
  const assertTrustedSender = vi.fn((event: TrustedSenderEvent) => {
    if (event.senderFrame?.url !== "app://trusted/") throw new Error("Blocked");
  });
  registerAppearanceIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    assertTrustedSender,
    appearance as never,
  );
  return { handlers, appearance };
}

const trusted = { senderFrame: { url: "app://trusted/" } } as TrustedSenderEvent;
const untrusted = { senderFrame: { url: "https://attacker.invalid/" } } as TrustedSenderEvent;

describe("appearance IPC", () => {
  it("rejects untrusted senders before touching the controller", () => {
    const { handlers, appearance } = register();
    expect(() => handlers.get("appearance:get")?.(untrusted)).toThrow("Blocked");
    expect(() => handlers.get("appearance:set")?.(untrusted, { transparency: "off" })).toThrow(
      "Blocked",
    );
    expect(appearance.getState).not.toHaveBeenCalled();
    expect(appearance.set).not.toHaveBeenCalled();
  });

  it("accepts exactly full | sidebar | off and known themes", () => {
    const { handlers, appearance } = register();
    for (const transparency of ["full", "sidebar", "off"]) {
      expect(handlers.get("appearance:set")?.(trusted, { transparency })).toEqual({ glass: false });
      expect(appearance.set).toHaveBeenLastCalledWith({ transparency });
    }
    for (const bad of [
      { transparency: "auto" },
      { transparency: "on" },
      { transparency: null },
      { theme: "neon" },
      { theme: "dark", extra: 1 },
      null,
    ]) {
      expect(() => handlers.get("appearance:set")?.(trusted, bad)).toThrow(/Invalid IPC payload/);
    }
    expect(handlers.get("appearance:get")?.(trusted)).toEqual({ glass: true });
  });
});
