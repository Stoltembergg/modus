// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../../../shared/contracts";
import { Composer } from "./Composer";

afterEach(cleanup);

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
    supportsThinking: true,
    thinkingLevel: "high",
    thinkingLevels: ["off", "low", "medium", "high"],
  },
  {
    id: "sonnet",
    name: "Claude Sonnet",
    provider: "anthropic",
    providerName: "Anthropic",
    available: true,
    enabled: true,
    configured: true,
    source: "builtin",
    supportsThinking: false,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
  },
];

function renderComposer(extra: Partial<Parameters<typeof Composer>[0]> = {}) {
  return render(
    <Composer
      canSubmit
      contextItems={[]}
      cwd="/repo"
      model="gpt-5"
      models={MODELS}
      onContextChange={vi.fn()}
      onSubmit={vi.fn()}
      workspaceId="w1"
      {...extra}
    />,
  );
}

describe("L2 Composer: no model / reasoning picker for anyone, branch picker kept", () => {
  it("renders no model chip, no effort chip and no model name", () => {
    renderComposer();
    expect(screen.queryByLabelText("Choose model")).toBeNull();
    expect(screen.queryByLabelText("Choose effort")).toBeNull();
    expect(screen.queryByText("GPT-5")).toBeNull();
    expect(screen.queryByText("Claude Sonnet")).toBeNull();
    expect(screen.queryByText("Effort")).toBeNull();
    expect(document.querySelector("[data-effort-max]")).toBeNull();
  });

  it("renders the host's branch control in the toolbar", () => {
    renderComposer({ branchControl: <button type="button">feat/l2</button> });
    expect(screen.getByRole("button", { name: "feat/l2" })).toBeTruthy();
  });

  it("the default model still drives sending (send enabled with content)", () => {
    renderComposer();
    expect(screen.getByLabelText("Send")).toBeTruthy();
  });
});
