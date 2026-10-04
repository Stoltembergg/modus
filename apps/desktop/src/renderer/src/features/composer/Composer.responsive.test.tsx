// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../../../shared/contracts";
import { installFixedWidthResizeObserver } from "../../lib/widthTierTestUtils";
import { Composer } from "./Composer";
import { useComposerToolbarTier } from "./composerToolbarTier";

const MODELS: ModelInfo[] = [
  {
    id: "gpt-5",
    name: "GPT-5",
    provider: "openai",
    providerName: "OpenAI",
    available: true,
    enabled: true,
    configured: true,
    source: "builtin",
    supportsThinking: false,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
  },
];

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function TierProbe() {
  return <span data-testid="tier-probe">{useComposerToolbarTier()}</span>;
}

function renderAt(width: number, onOpenConnections = vi.fn()) {
  restore = installFixedWidthResizeObserver(width);
  render(
    <Composer
      branchControl={<TierProbe />}
      canSubmit
      contextItems={[]}
      cwd="/repo"
      model="gpt-5"
      models={MODELS}
      onContextChange={vi.fn()}
      onOpenConnections={onOpenConnections}
      onSubmit={vi.fn()}
      workspaceId="w1"
    />,
  );
  return { onOpenConnections };
}

describe("Composer toolbar responsive (L3c)", () => {
  it("lg: Attach and labelled Connections inline, no overflow menu", () => {
    renderAt(700);
    expect(screen.getByTestId("composer-toolbar").dataset.widthTier).toBe("lg");
    expect(screen.getByTestId("tier-probe").textContent).toBe("lg");
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connections" }).textContent).toBe("Connections");
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("md: Connections icon-only (still labelled), no overflow menu", () => {
    renderAt(450);
    expect(screen.getByTestId("tier-probe").textContent).toBe("md");
    const connections = screen.getByRole("button", { name: "Connections" });
    expect(connections.textContent).toBe("");
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("sm: Attach and Connections move into More actions (keyboard reachable)", async () => {
    const user = userEvent.setup();
    const { onOpenConnections } = renderAt(330);
    expect(screen.getByTestId("tier-probe").textContent).toBe("sm");
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connections" })).toBeNull();
    // Send stays on the bar.
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    const trigger = screen.getByRole("button", { name: "More actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByTestId("composer-overflow-menu");
    expect(screen.getByRole("menuitem", { name: "Attach files" })).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Connections" }));
    expect(onOpenConnections).toHaveBeenCalledTimes(1);
    expect(menu).toBeTruthy();
  });
});
