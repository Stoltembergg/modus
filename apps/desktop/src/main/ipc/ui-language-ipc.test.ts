import { describe, expect, it, vi } from "vitest";
import type { TrustedSenderEvent } from "./trusted-sender";
import { registerUiLanguageIpcHandlers } from "./ui-language-ipc";

function register() {
  const handlers = new Map<string, (event: TrustedSenderEvent, input?: unknown) => unknown>();
  const uiLanguage = {
    getState: vi.fn(() => ({ language: "en" })),
    set: vi.fn((preference: string) => ({ preference })),
  };
  const assertTrustedSender = vi.fn((event: TrustedSenderEvent) => {
    if (event.senderFrame?.url !== "app://trusted/") throw new Error("Blocked");
  });
  registerUiLanguageIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    assertTrustedSender,
    uiLanguage as never,
  );
  return { handlers, uiLanguage };
}

const trusted = { senderFrame: { url: "app://trusted/" } } as TrustedSenderEvent;
const untrusted = { senderFrame: { url: "https://attacker.invalid/" } } as TrustedSenderEvent;

describe("language IPC", () => {
  it("rejects untrusted senders", () => {
    const { handlers, uiLanguage } = register();
    expect(() => handlers.get("ui-language:get")?.(untrusted)).toThrow("Blocked");
    expect(() => handlers.get("ui-language:set")?.(untrusted, { preference: "en" })).toThrow(
      "Blocked",
    );
    expect(uiLanguage.set).not.toHaveBeenCalled();
  });

  it("accepts System and the shipped languages only", () => {
    const { handlers, uiLanguage } = register();
    for (const preference of ["system", "en", "pt-BR"]) {
      expect(handlers.get("ui-language:set")?.(trusted, { preference })).toEqual({ preference });
    }
    for (const input of [{ preference: "fr-FR" }, { preference: "pt-BR", extra: 1 }, "pt-BR"]) {
      expect(() => handlers.get("ui-language:set")?.(trusted, input)).toThrow();
    }
    expect(uiLanguage.set).toHaveBeenCalledTimes(3);
  });
});
