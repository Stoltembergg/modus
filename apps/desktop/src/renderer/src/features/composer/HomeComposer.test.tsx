// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../../../shared/contracts";
import { type ComposerDraft, createEmptyComposerDraft } from "./Composer";
import { HomeComposer } from "./HomeComposer";

afterEach(cleanup);

function model(id: string, name: string): ModelInfo {
  return {
    id,
    name,
    provider: id.split("/")[0] ?? id,
    available: true,
    enabled: true,
    configured: true,
    source: "builtin",
    supportsThinking: false,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
  };
}

const MODELS = [model("openai/gpt-5", "GPT-5"), model("anthropic/sonnet", "Claude Sonnet")];

/** Mirrors App's hero wiring: the host owns the pick and creates the chat with it on send. */
function Harness({
  defaultModelId,
  onSend,
  initialText = "",
}: {
  defaultModelId: string;
  onSend(message: string, modelId: string): void;
  initialText?: string;
}) {
  const [heroModel, setHeroModel] = useState("");
  const [draft, setDraft] = useState<ComposerDraft>({
    ...createEmptyComposerDraft(),
    value: initialText,
  });
  return (
    <HomeComposer
      canSubmit
      contextItems={[]}
      cwd="/repo"
      defaultModelId={defaultModelId}
      draft={draft}
      heroModel={heroModel}
      models={MODELS}
      onContextChange={vi.fn()}
      onDraftChange={setDraft}
      onHeroModelChange={setHeroModel}
      onSubmit={(message) => onSend(message, heroModel || defaultModelId)}
      workspaceId="w1"
    />
  );
}

const send = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

describe("Home composer can send a first message with no session model", () => {
  it("no default configured: picking a model enables send and the message goes out with it", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Harness defaultModelId="" initialText="hello" onSend={onSend} />);
    // Without a model there is nothing to send with.
    expect(send().disabled).toBe(true);
    await user.click(screen.getByTestId("model-picker-trigger"));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: "Claude Sonnet" }));
    await waitFor(() => expect(send().disabled).toBe(false));
    await user.click(send());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello", "anthropic/sonnet"));
  });

  it("with an app default: typed text sends with the default model", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Harness defaultModelId="openai/gpt-5" initialText="ship it" onSend={onSend} />);
    expect(screen.getByTestId("model-picker-trigger").textContent).toMatch(/GPT-5/);
    expect(send().disabled).toBe(false);
    await user.click(send());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("ship it", "openai/gpt-5"));
  });
});

describe("Home composer footer", () => {
  it("has no divider above the branch tray", () => {
    render(
      <HomeComposer
        canSubmit
        contextItems={[]}
        cwd="/repo"
        defaultModelId="openai/gpt-5"
        footer={<span>No branch</span>}
        heroModel=""
        models={MODELS}
        onContextChange={vi.fn()}
        onHeroModelChange={vi.fn()}
        onSubmit={vi.fn()}
        workspaceId="w1"
      />,
    );
    const footer = screen.getByTestId("composer-footer");
    expect(footer.className).not.toMatch(/border-t/);
  });
});
