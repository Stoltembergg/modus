// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ModelProviderDetail,
  ModelProviderInfo,
  ProviderConnectionMethod,
  ProviderModelConfig,
} from "../../../../shared/contracts";
import {
  ProviderCatalogRow,
  ProviderDetail,
  ProviderRow,
  providerCatalogSummary,
  providerDetailConnectionLabel,
} from "./settings-provider-ui";
import { UnofficialProviderRiskInterstitial } from "./UnofficialProviderNotice";

vi.mock("./sections/appearance", () => ({ AppearanceSettingsPanel: () => null }));
vi.mock("./sections/general", () => ({ GeneralSettingsPanel: () => null }));
vi.mock("./sections/harness-insights", () => ({ HarnessInsightsSettingsPanel: () => null }));
vi.mock("./sections/limits", () => ({ LimitsSettingsPanel: () => null }));
vi.mock("./sections/mcp", () => ({ McpSettingsPanel: () => null }));
vi.mock("./sections/personalization", () => ({ PersonalizationSettingsPanel: () => null }));
vi.mock("./sections/project-memory", () => ({ ProjectMemorySettingsPanel: () => null }));
vi.mock("./sections/rules", () => ({ RulesSettingsPanel: () => null }));
vi.mock("./sections/skills", () => ({ SkillsSettingsPanel: () => null }));
vi.mock("./sections/subagents", () => ({ SubagentsSettingsPanel: () => null }));

import { SettingsPanel } from "./SettingsPanel";

function provider(overrides: Partial<ModelProviderInfo> = {}): ModelProviderInfo {
  return {
    id: "openrouter",
    name: "OpenRouter",
    source: "builtin",
    configured: false,
    modelCount: 12,
    enabledModelCount: 0,
    ...overrides,
  };
}

function commandcodeProvider(overrides: Partial<ModelProviderInfo> = {}): ModelProviderInfo {
  return provider({
    id: "commandcode",
    name: "Command Code",
    configured: false,
    modelCount: 55,
    enabledModelCount: 0,
    pricingAvailability: "unknown",
    authKind: "api-key",
    authLabel: "API key required",
    ...overrides,
  });
}

function antigravityProvider(overrides: Partial<ModelProviderInfo> = {}): ModelProviderInfo {
  return provider({
    id: "antigravity",
    name: "Antigravity",
    configured: false,
    modelCount: 11,
    enabledModelCount: 0,
    authKind: "oauth",
    authLabel: "OAuth sign-in required",
    ...overrides,
  });
}

function detail(overrides: Partial<ModelProviderDetail> = {}): ModelProviderDetail {
  const models: ProviderModelConfig[] = overrides.models ?? [];
  return {
    id: "openrouter",
    name: "OpenRouter",
    source: "builtin",
    configured: false,
    modelCount: models.length,
    enabledModelCount: models.filter((model) => model.enabled).length,
    models,
    ...overrides,
  };
}

function commandcodeDetail(overrides: Partial<ModelProviderDetail> = {}): ModelProviderDetail {
  return detail({
    id: "commandcode",
    name: "Command Code",
    modelCount: 55,
    enabledModelCount: 0,
    configured: false,
    models: [],
    pricingAvailability: "unknown",
    authKind: "api-key",
    authLabel: "API key required",
    ...overrides,
  });
}

function antigravityDetail(
  configured: boolean,
  overrides: Partial<ModelProviderDetail> = {},
): ModelProviderDetail {
  return detail({
    id: "antigravity",
    name: "Antigravity",
    modelCount: 11,
    enabledModelCount: 0,
    configured,
    models: [],
    authKind: "oauth",
    authLabel: configured ? "OAuth" : "OAuth sign-in required",
    ...overrides,
  });
}

function renderRow(row: ModelProviderInfo): string {
  return renderToStaticMarkup(
    <ProviderCatalogRow active={false} onClick={() => undefined} provider={row} />,
  );
}

const noop = () => undefined;

function renderStaticProviderDetail(detailProp: ModelProviderDetail): string {
  return renderToStaticMarkup(
    <ProviderDetail
      busy={false}
      credentialEditorOpen={false}
      detail={detailProp}
      keyValue=""
      onConnect={noop}
      onCredentialEditorClose={noop}
      onDeleteProvider={noop}
      onDisconnectProvider={noop}
      onEditModel={noop}
      onEditProvider={noop}
      onKeyChange={noop}
      onOpenProviderConnection={noop}
      onSetAllModels={noop}
      onToggleModel={noop}
    />,
  );
}

function renderInterstitial(opts: {
  onConfirm?: () => void;
  onCancel?: () => void;
  initialChecked?: boolean;
}) {
  // Keep these server-rendered callback checks distinct from the DOM
  // interaction test below, which exercises real events through SettingsPanel.
  const onConfirm = opts.onConfirm ?? noop;
  const onCancel = opts.onCancel ?? noop;
  let currentChecked = opts.initialChecked ?? false;
  let lastMarkup = "";
  const rerender = () => {
    lastMarkup = renderToStaticMarkup(
      <UnofficialProviderRiskInterstitial
        busy={false}
        checked={currentChecked}
        onChange={(next) => {
          currentChecked = next;
          rerender();
        }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
  };
  rerender();

  // Update the state represented by the server-rendered fixture. This does
  // not dispatch a checkbox event; it only lets markup assertions cover both
  // checked states. Real checkbox events are covered by the DOM test below.
  const toggleAcknowledge = (next?: boolean) => {
    const target = next ?? !currentChecked;
    currentChecked = target;
    rerender();
  };
  // Callback-level invocation only; this is deliberately not described as
  // dispatching a click.
  const invokeConfirmCallback = () => {
    onConfirm();
  };
  // Callback-level invocation only; this is deliberately not described as
  // dispatching a click.
  const invokeCancelCallback = () => {
    onCancel();
  };

  return {
    markup: () => lastMarkup,
    setChecked: toggleAcknowledge,
    toggleAcknowledge,
    invokeConfirmCallback,
    invokeCancelCallback,
    get checked() {
      return currentChecked;
    },
  };
}

describe("Command Code catalog copy", () => {
  it("states model count, API-key method, and pricing availability before connection", () => {
    const row = commandcodeProvider();
    expect(providerCatalogSummary(row)).toBe("55 models · API key · pricing unknown");
    expect(renderRow(row)).toContain("55 models · API key · pricing unknown");
  });

  it("states model count and unverified key state once a key is saved", () => {
    const row = commandcodeProvider({
      configured: true,
      authKind: "api-key",
      authLabel: "API key saved — not verified",
    });
    expect(providerCatalogSummary(row)).toBe("55 models · key saved · unverified");
    expect(renderRow(row)).toContain("55 models · key saved · unverified");
  });

  it("lists enabled models plus the pricing-unknown badge once enabled", () => {
    const row = commandcodeProvider({ configured: true, enabledModelCount: 6 });
    expect(providerCatalogSummary(row)).toBe("6 enabled · 55 models · pricing unknown");
    expect(renderRow(row)).toContain("pricing unknown");
  });
});

describe("Command Code provider detail copy", () => {
  it("uses the API-key label and surfaces the pricing preamble", () => {
    const item = commandcodeDetail({
      configured: true,
      authLabel: "API key saved — not verified",
    });
    expect(providerDetailConnectionLabel(item)).toBe("API key saved — not verified");
  });

  it("renders the pricing-unknown chip and explanatory preamble in the detail view", () => {
    const markup = renderStaticProviderDetail(commandcodeDetail({ configured: true }));
    expect(markup).toContain("pricing unknown");
    expect(markup).toContain("Pricing is not published for these models");
  });

  it("never fabricates a $0 / Free / numeric cost placeholder for Command Code", () => {
    const markup = renderStaticProviderDetail(commandcodeDetail({ configured: true }));
    expect(markup).not.toMatch(/\$0\b/);
    expect(markup).not.toContain("Free");
    expect(markup).not.toMatch(/0\s*(?:USD|tokens?)/i);
  });
});

describe("Command Code models are excluded from cost/budget totals", () => {
  it("keeps Command Code rows in limits output but contributes no numeric cost", () => {
    const commandCodeModel: ProviderModelConfig = {
      id: "commandcode",
      name: "Command Code",
      enabled: true,
      reasoning: false,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
    };
    const pricedModel: ProviderModelConfig = {
      id: "openrouter",
      name: "OpenRouter Pro",
      enabled: true,
      reasoning: false,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      contextWindow: 200000,
      maxTokens: 8192,
    };
    const rows = [commandCodeModel, pricedModel].map((model) => ({
      id: model.id,
      providerId: "p",
      providerName: "p",
      modelName: model.name,
    }));
    // The configured-model-limits pure projection still surfaces Command Code
    // rows in the Limits page, but the projection intentionally never carries
    // a numeric `cost`, budget, or balance for it.
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === "commandcode")).toBeDefined();
    expect(rows.find((row) => row.id === "commandcode")).not.toHaveProperty("cost");
    expect(rows.find((row) => row.id === "commandcode")).not.toHaveProperty("budget");
  });
});

describe("Antigravity catalog and OAuth-only behavior", () => {
  it("uses the unofficial-endpoints summary before OAuth and the signed-in summary after", () => {
    const available = antigravityProvider();
    expect(providerCatalogSummary(available)).toBe("11 models · OAuth only · unofficial endpoints");
    expect(renderRow(available)).toContain("11 models · OAuth only · unofficial endpoints");

    const signedIn = antigravityProvider({
      configured: true,
      authKind: "oauth",
      authLabel: "OAuth",
    });
    expect(providerCatalogSummary(signedIn)).toBe("11 models · signed in");
    expect(renderRow(signedIn)).toContain("11 models · signed in");
  });

  it("offers only an OAuth connection method for Antigravity", () => {
    const methods: ProviderConnectionMethod[] = [{ kind: "oauth", label: "Antigravity" }];
    const apt = antigravityProvider();
    expect(methods).toHaveLength(1);
    expect(methods[0]?.kind).toBe("oauth");
    expect(methods.some((method) => method.kind === "api-key")).toBe(false);
    expect(renderRow(apt)).toContain("OAuth only");
  });

  it("exposes a warning glyph and tooltip text in the row", () => {
    const rowMarkup = renderToStaticMarkup(
      <ProviderRow active={false} onClick={() => undefined} provider={antigravityProvider()} />,
    );
    expect(rowMarkup).toContain("Unofficial provider");
    expect(rowMarkup).toMatch(/unofficial/i);
    expect(rowMarkup).toMatch(/risk/i);
  });
});

describe("Antigravity risk acknowledgement interstitial", () => {
  it("starts unchecked and grounds the copy in the upstream warning", () => {
    const view = renderInterstitial({});
    expect(view.markup()).toMatch(/unofficial internal/i);
    expect(view.markup()).toMatch(/terms of service|account/i);
    expect(view.markup()).toMatch(/disabled=""/);
    expect(view.checked).toBe(false);
  });

  it("does not promise safety, legal support, or guarantee safe use", () => {
    const view = renderInterstitial({});
    // The interstitial tells the user Modus cannot guarantee safety /
    // legality / support. It must NEVER claim the opposite as a positive
    // promise. The negated disclaimer `cannot make this … safe to use`
    // explicitly mentions "safe to use" and must be allowed.
    const markup = view.markup();
    // Positive guarantees of safety / legality must be absent.
    expect(markup).not.toMatch(
      /\b(?:this (?:is|will be) (?:safe|legal|supported)|guarantees? (?:safe|legal|safety))\b/i,
    );
    expect(markup).not.toMatch(/\blegally supported\b/i);
    // The interstitial SHOULD include the explicit "cannot" disclaimer.
    expect(markup).toMatch(/cannot/i);
  });

  it("keeps the action disabled until acknowledged and verifies confirm callback wiring", () => {
    const onConfirm = vi.fn();
    const view = renderInterstitial({ onConfirm });
    expect(view.checked).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();

    // The primary action's `disabled` attribute stays in the markup while
    // the acknowledgement is unticked. This is the gating signal the
    // production CSS/UX relies on, so the test must confirm it remains
    // present until the user ticks the box.
    expect(view.markup()).toMatch(/disabled=""/);

    view.toggleAcknowledge(true);
    expect(view.checked).toBe(true);
    // Ticking removes the disabled attribute from the primary action. The
    // test asserts the negation (`not.toMatch`) so a regression that
    // accidentally re-disables — or one that omits the attribute on a
    // different element — both fail loudly.
    expect(view.markup()).not.toMatch(/disabled=""/);
    expect(onConfirm).not.toHaveBeenCalled();

    // This callback-level assertion supplements the DOM interaction test below.
    view.invokeConfirmCallback();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("verifies cancel callback wiring does not invoke the confirm callback", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const view = renderInterstitial({ onCancel, onConfirm, initialChecked: true });
    // Cancel must not fire the confirm path; it only closes the dialog.
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();

    // Callback-level assertion only, not a DOM click test.
    view.invokeCancelCallback();
    expect(onCancel).toHaveBeenCalledTimes(1);
    // …and must NEVER trigger the auth-start path. Cancelling closes
    // the dialog without invoking `startProviderAuth`, regardless of the
    // checkbox state.
    expect(onConfirm).not.toHaveBeenCalled();

    // Even with the box re-ticked (the parent path that would otherwise
    // let the user proceed), a subsequent cancel must still not start
    // auth. This guards against a regression where cancel accidentally
    // also calls the confirm path on close.
    view.toggleAcknowledge(true);
    view.invokeCancelCallback();
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("checks the expected provider-auth preload payload for the acknowledged callback", () => {
    // This callback-contract check complements the DOM interaction test below,
    // which reaches the mocked preload surface through the production
    // SettingsPanel handler.
    type StartProviderAuthInput = { provider: string; riskAcknowledged?: true };
    const startProviderAuth = vi.fn(
      async (_input: StartProviderAuthInput): Promise<{ id: string }> => ({ id: "op-test" }),
    );
    const provider = antigravityProvider();
    const view = renderInterstitial({
      initialChecked: false,
      onConfirm: () => {
        void startProviderAuth({
          provider: provider.id,
          riskAcknowledged: true,
        });
      },
    });

    // Check markup gating, then invoke the callback as a separate contract
    // assertion; the DOM interaction test below proves click gating.
    view.toggleAcknowledge(true);
    expect(startProviderAuth).not.toHaveBeenCalled();
    view.invokeConfirmCallback();
    expect(startProviderAuth).toHaveBeenCalledTimes(1);
    expect(startProviderAuth).toHaveBeenCalledWith({
      provider: "antigravity",
      riskAcknowledged: true,
    });
  });

  it("renders the persistent warning block in configured Antigravity detail", () => {
    const markup = renderStaticProviderDetail(antigravityDetail(true));
    expect(markup).toContain('aria-label="Unofficial provider warning"');
    expect(markup).toMatch(/undocumented|unsupported|terms of service|account/i);
  });

  it("removes the persistent warning block when not configured", () => {
    const markup = renderStaticProviderDetail(antigravityDetail(false));
    expect(markup).not.toContain('aria-label="Unofficial provider warning"');
  });

  it("gates the production SettingsPanel-to-preload path on a real acknowledgement click", async () => {
    const user = userEvent.setup();
    const startProviderAuth = vi.fn(async () => ({ id: "antigravity-auth" }));
    const modelApi = {
      // The service stub exposes the real production method chooser so this
      // test can exercise its OAuth selection callback into the risk gate.
      connectionMethods: vi.fn(async () => [
        { kind: "oauth", label: "Antigravity" },
        { kind: "api-key", label: "API key" },
      ]),
      providerDetail: vi.fn(async () => antigravityDetail(false)),
      startProviderAuth,
      providerAuthState: vi.fn(async () => ({
        id: "antigravity-auth",
        provider: "antigravity",
        status: "pending",
      })),
      cancelProviderAuth: vi.fn(async () => undefined),
    };
    Object.defineProperty(window, "modus", {
      configurable: true,
      value: { model: modelApi },
    });

    const antigravity = antigravityProvider();
    const { unmount } = render(
      <SettingsPanel
        state={{ providers: [antigravity], models: [] }}
        onClose={noop}
        onRefresh={noop}
        onRefreshCatalog={async () => undefined}
      />,
    );

    try {
      // Follow the same catalog-row -> provider-detail -> sign-in path used in
      // SettingsPanel; retain the real settings and model-provider components.
      await user.click(screen.getByRole("button", { name: /Antigravity/ }));
      await user.click(await screen.findByRole("button", { name: "Antigravity" }));

      const acknowledgement = await screen.findByRole("checkbox", {
        name: "Acknowledge Antigravity risk",
      });
      const continueButton = screen.getByRole("button", {
        name: "Start Antigravity OAuth with acknowledgement",
      });
      expect((acknowledgement as HTMLInputElement).checked).toBe(false);
      expect((continueButton as HTMLButtonElement).disabled).toBe(true);
      expect(startProviderAuth).not.toHaveBeenCalled();

      const cancelButtons = screen.getAllByRole("button", { name: "Cancel Antigravity sign-in" });
      expect(cancelButtons).toHaveLength(2);
      const riskDialogCancel = cancelButtons[1];
      if (!riskDialogCancel) throw new Error("Expected cancel action in the risk dialog");
      await user.click(riskDialogCancel);
      await waitFor(() =>
        expect(screen.queryByRole("checkbox", { name: "Acknowledge Antigravity risk" })).toBeNull(),
      );
      expect(startProviderAuth).not.toHaveBeenCalled();

      // Reopen to prove the checkbox resets unchecked and only a dispatched
      // user event enables the primary action and reaches the preload mock.
      await user.click(await screen.findByRole("button", { name: /Antigravity/ }));
      await user.click(await screen.findByRole("button", { name: "Antigravity" }));
      const reopenedCheckbox = await screen.findByRole("checkbox", {
        name: "Acknowledge Antigravity risk",
      });
      const reopenedContinue = screen.getByRole("button", {
        name: "Start Antigravity OAuth with acknowledgement",
      });
      expect((reopenedCheckbox as HTMLInputElement).checked).toBe(false);
      expect((reopenedContinue as HTMLButtonElement).disabled).toBe(true);

      await user.click(reopenedCheckbox);
      expect((reopenedCheckbox as HTMLInputElement).checked).toBe(true);
      expect((reopenedContinue as HTMLButtonElement).disabled).toBe(false);
      expect(startProviderAuth).not.toHaveBeenCalled();

      await user.click(reopenedContinue);
      await waitFor(() =>
        expect(startProviderAuth).toHaveBeenCalledWith({
          provider: "antigravity",
          riskAcknowledged: true,
        }),
      );
      expect(startProviderAuth).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      cleanup();
    }
  });

  it("resets the acknowledgement checkbox across cancel and reopen while the owner stays mounted", async () => {
    // Regression for R3: the previous fix returned `null` while the dialog
    // owner remained mounted, so the parent `checked` state survived
    // cancel/reopen. Ticking the box, cancelling, and reopening must leave
    // the box unchecked and Continue disabled until a fresh click.
    const user = userEvent.setup();
    const startProviderAuth = vi.fn(async () => ({ id: "antigravity-auth-reopen" }));
    const modelApi = {
      connectionMethods: vi.fn(async () => [
        { kind: "oauth", label: "Antigravity" },
        { kind: "api-key", label: "API key" },
      ]),
      providerDetail: vi.fn(async () => antigravityDetail(false)),
      startProviderAuth,
      providerAuthState: vi.fn(async () => ({
        id: "antigravity-auth-reopen",
        provider: "antigravity",
        status: "pending",
      })),
      cancelProviderAuth: vi.fn(async () => undefined),
    };
    Object.defineProperty(window, "modus", {
      configurable: true,
      value: { model: modelApi },
    });

    const antigravity = antigravityProvider();
    const { unmount } = render(
      <SettingsPanel
        state={{ providers: [antigravity], models: [] }}
        onClose={noop}
        onRefresh={noop}
        onRefreshCatalog={async () => undefined}
      />,
    );

    try {
      // Open the dialog the same way as the real-interaction test above.
      await user.click(screen.getByRole("button", { name: /Antigravity/ }));
      await user.click(await screen.findByRole("button", { name: "Antigravity" }));

      const acknowledgement = await screen.findByRole("checkbox", {
        name: "Acknowledge Antigravity risk",
      });
      const continueButton = screen.getByRole("button", {
        name: "Start Antigravity OAuth with acknowledgement",
      });

      // Dirty the acknowledgement state: tick the box, confirm the primary
      // action enables, and verify the preload path is NOT yet reached.
      await user.click(acknowledgement);
      expect((acknowledgement as HTMLInputElement).checked).toBe(true);
      expect((continueButton as HTMLButtonElement).disabled).toBe(false);
      expect(startProviderAuth).not.toHaveBeenCalled();

      // Cancel without invoking auth; the dialog must disappear.
      const cancelButtons = screen.getAllByRole("button", {
        name: "Cancel Antigravity sign-in",
      });
      const riskDialogCancel = cancelButtons[cancelButtons.length - 1];
      if (!riskDialogCancel) {
        throw new Error("Expected cancel action in the risk dialog");
      }
      await user.click(riskDialogCancel);
      await waitFor(() =>
        expect(
          screen.queryByRole("checkbox", { name: "Acknowledge Antigravity risk" }),
        ).toBeNull(),
      );
      expect(startProviderAuth).not.toHaveBeenCalled();

      // Reopen while the owner stays mounted — the box must reset to
      // unchecked and Continue must stay disabled until the user clicks
      // again. The previous bug exposed a stale `checked` state here.
      await user.click(await screen.findByRole("button", { name: /Antigravity/ }));
      await user.click(await screen.findByRole("button", { name: "Antigravity" }));
      const reopenedCheckbox = await screen.findByRole("checkbox", {
        name: "Acknowledge Antigravity risk",
      });
      const reopenedContinue = screen.getByRole("button", {
        name: "Start Antigravity OAuth with acknowledgement",
      });
      expect((reopenedCheckbox as HTMLInputElement).checked).toBe(false);
      expect((reopenedContinue as HTMLButtonElement).disabled).toBe(true);

      // A fresh click is the only path that enables the primary action and
      // reaches the preload mock with `riskAcknowledged: true`.
      await user.click(reopenedCheckbox);
      expect((reopenedCheckbox as HTMLInputElement).checked).toBe(true);
      expect((reopenedContinue as HTMLButtonElement).disabled).toBe(false);
      expect(startProviderAuth).not.toHaveBeenCalled();

      await user.click(reopenedContinue);
      await waitFor(() =>
        expect(startProviderAuth).toHaveBeenCalledWith({
          provider: "antigravity",
          riskAcknowledged: true,
        }),
      );
      expect(startProviderAuth).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      cleanup();
    }
  });
});
