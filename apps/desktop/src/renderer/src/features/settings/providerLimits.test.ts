import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../../../shared/contracts";
import {
  accountMetricLabel,
  accountStatusLabel,
  configuredModelLimits,
  groupConfiguredModelLimits,
  usageMetricText,
} from "./SettingsPanel";

const model = (
  overrides: Partial<Omit<ModelInfo, "providerName">> &
    Pick<ModelInfo, "id"> & { providerName?: string | undefined },
): ModelInfo =>
  ({
    provider: "openrouter",
    providerName: "OpenRouter",
    name: overrides.id,
    available: true,
    enabled: true,
    configured: true,
    source: "builtin",
    supportsThinking: false,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    ...overrides,
  }) as ModelInfo;

describe("configuredModelLimits", () => {
  it("keeps only enabled models from configured providers", () => {
    const rows = configuredModelLimits([
      model({ id: "a", contextWindow: 200000, maxTokens: 8192 }),
      model({ id: "b", enabled: false }),
      model({ id: "c", configured: false }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["a"]);
    expect(rows[0]).toEqual({
      id: "a",
      providerId: "openrouter",
      providerName: "OpenRouter",
      modelName: "a",
      contextWindow: 200000,
      maxTokens: 8192,
    });
  });

  it("omits missing catalog values instead of reporting zero", () => {
    const [row] = configuredModelLimits([model({ id: "a" })]);
    expect(row).not.toHaveProperty("contextWindow");
    expect(row).not.toHaveProperty("maxTokens");
  });

  it("never invents a cost, budget, or zero pricing for native providers", () => {
    const commandCodeModel = model({
      id: "commandcode",
      provider: "commandcode",
      providerName: undefined,
    });
    const antigravityModel = model({
      id: "antigravity",
      provider: "antigravity",
      providerName: undefined,
    });
    const rows = configuredModelLimits([commandCodeModel, antigravityModel]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveProperty("cost");
      expect(row).not.toHaveProperty("budget");
      expect(row).not.toHaveProperty("pricePerToken");
      expect(row).not.toHaveProperty("balance");
      expect(row).not.toHaveProperty("$0");
      // Provider id remains authoritative when no display name exists.
      expect(row.providerId).toBe(row.id);
    }
  });

  it("falls back to the provider id when no display name exists", () => {
    const [row] = configuredModelLimits([
      model({ id: "a", provider: "deepseek", providerName: undefined }),
    ]);
    expect(row?.providerName).toBe("deepseek");
  });
});

describe("groupConfiguredModelLimits", () => {
  it("groups by provider name preserving first-seen order", () => {
    const rows = configuredModelLimits([
      model({ id: "a", providerName: "OpenRouter" }),
      model({ id: "b", providerName: "DeepSeek" }),
      model({ id: "c", providerName: "OpenRouter" }),
    ]);
    expect(groupConfiguredModelLimits(rows).map(([name, group]) => [name, group.length])).toEqual([
      ["OpenRouter", 2],
      ["DeepSeek", 1],
    ]);
  });
});

describe("accountStatusLabel", () => {
  it("labels fresh and stale snapshots", () => {
    expect(accountStatusLabel("fresh")).toBe("Updated");
    expect(accountStatusLabel("stale")).toBe("Stale");
  });

  it("distinguishes the unavailable reasons", () => {
    expect(accountStatusLabel("unavailable", "unsupported")).toBe("No supported source");
    expect(accountStatusLabel("unavailable", "not-configured")).toBe("Not configured");
    expect(accountStatusLabel("unavailable", "codex-disabled")).toBe("Codex CLI off");
    expect(accountStatusLabel("unavailable", "codex-cli-missing")).toBe("Codex CLI not found");
  });

  it("distinguishes auth failures from network/protocol errors", () => {
    expect(accountStatusLabel("error", "authentication-failed")).toBe("Authentication failed");
    expect(accountStatusLabel("error", "request-failed")).toBe("Request failed");
    expect(accountStatusLabel("error", "invalid-response")).toBe("Unexpected response");
  });
});

describe("usageMetricText", () => {
  it("keeps provider units explicit", () => {
    expect(
      usageMetricText({ id: "b", label: "Balance", kind: "balance", value: 12.5, unit: "USD" }),
    ).toBe("12.5 USD");
  });

  it("shows value against its limit when a budget is reported", () => {
    expect(
      usageMetricText({
        id: "k",
        label: "Key budget",
        kind: "budget",
        value: 1.2,
        limit: 10,
        unit: "USD",
      }),
    ).toBe("1.2 / 10 USD");
  });

  it("does not repeat the same value for a budget metric", () => {
    expect(
      usageMetricText({
        id: "k",
        label: "Key budget",
        kind: "budget",
        value: 10,
        limit: 10,
        unit: "USD",
      }),
    ).toBe("10 USD");
  });

  it("renders percent units without a space", () => {
    expect(
      usageMetricText({
        id: "r",
        label: "Primary window",
        kind: "rate-limit",
        value: 30,
        unit: "%",
        window: "5h",
      }),
    ).toBe("30%");
  });
});

describe("accountMetricLabel", () => {
  it("does not present key budgets or balances as rate limits", () => {
    expect(
      accountMetricLabel({ id: "b", label: "Rate limit", kind: "budget", value: 10, unit: "USD" }),
    ).toBe("Key budget");
    expect(
      accountMetricLabel({ id: "b", label: "Rate limit", kind: "balance", value: 10, unit: "USD" }),
    ).toBe("Account balance");
    expect(
      accountMetricLabel({
        id: "r",
        label: "Primary window",
        kind: "rate-limit",
        value: 30,
        unit: "%",
      }),
    ).toBe("Primary window");
  });
});
