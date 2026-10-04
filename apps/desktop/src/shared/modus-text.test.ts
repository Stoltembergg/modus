import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { MODUS_TEXT, MODUS_TEXT_EN, type ModusTextKey, modusText } from "./modus-text";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const KEYS = Object.keys(MODUS_TEXT_EN) as ModusTextKey[];

describe("Modus catalog parity (en / pt / zh)", () => {
  for (const [locale, table] of Object.entries(MODUS_TEXT)) {
    it(`${locale} has exactly the en keys, non-empty, same placeholders`, () => {
      expect(Object.keys(table).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        expect(table[key].trim(), `${locale} ${key}`).not.toBe("");
        expect(placeholders(table[key]), `${locale} ${key}`).toEqual(
          placeholders(MODUS_TEXT_EN[key]),
        );
        if (locale !== "en") expect(table[key], `${locale} ${key}`).not.toBe(MODUS_TEXT_EN[key]);
      }
    });
  }
});

describe("modusText", () => {
  it("defaults to en without a tag (C6.2) and resolves pt / zh tags", () => {
    expect(modusText("modus.sessionExpired")).toBe("Your session expired. Please sign in again.");
    expect(modusText("modus.sessionExpired", "pt-BR")).toBe("Sua sessão expirou, entre de novo.");
    expect(modusText("modus.status.unavailable", "pt")).toBe("Indisponível");
    expect(modusText("modus.timeout", "pt-PT")).toBe(
      "O modelo demorou demais para responder. Alguns créditos podem ter sido usados.",
    );
    expect(modusText("modus.timeout")).toBe(
      "The model took too long to respond. Some credits may have been used.",
    );
    expect(modusText("modus.status.unavailable", "fr")).toBe("Unavailable");
  });

  it("fills placeholders and only the 504 copy mentions credits being used", () => {
    expect(modusText("modus.locked.buyCredits", null, { model: "GLM" })).toBe(
      "Buy credits to unlock GLM",
    );
    expect(modusText("modus.locked.buyCredits", "pt", { model: "GLM" })).toBe(
      "Compre créditos para desbloquear GLM",
    );
    expect(modusText("modus.unavailable")).not.toMatch(/credit/i);
  });
});

describe("no automatic agent retry", () => {
  it("no Modus message (en / pt / zh) is classified as retryable by pi", () => {
    for (const [locale, table] of Object.entries(MODUS_TEXT)) {
      for (const [key, errorMessage] of Object.entries(table)) {
        const retryable = isRetryableAssistantError({
          role: "assistant",
          content: [],
          api: "modus-router",
          provider: "modus",
          model: "m",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage,
          timestamp: 0,
        });
        expect(retryable, `${locale} ${key}: ${errorMessage}`).toBe(false);
      }
    }
  });
});
