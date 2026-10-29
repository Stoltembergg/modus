// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextItem, ModelInfo, SkillSelection } from "../../../../shared/contracts";
import { ImageViewerProvider } from "../../components/ui/ImageViewer";
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

function AdmissionHarness({ onSend }: { onSend: (...args: unknown[]) => Promise<void> }) {
  const [draft, setDraft] = useState<ComposerDraft>({
    ...createEmptyComposerDraft(),
    value: "first prompt",
    images: [
      {
        id: "image-1",
        name: "mock-image.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AA==",
      },
    ],
    selectedSkills: [{ name: "review", path: "/repo/.modus/skills/review.md" }],
    parts: [
      { type: "text", text: "first prompt" },
      {
        type: "skill",
        skill: { name: "review", path: "/repo/.modus/skills/review.md" },
      },
    ],
  });
  const [contextItems, setContextItems] = useState<ContextItem[]>([
    { type: "file", path: "/repo/notes.md" },
  ]);
  const [composerMounted, setComposerMounted] = useState(true);

  return (
    <ImageViewerProvider>
      <button onClick={() => setComposerMounted(false)} type="button">
        Unmount composer
      </button>
      <button
        onClick={() =>
          setDraft((current) => ({
            ...current,
            value: "newer draft",
            parts: [{ type: "text", text: "newer draft" }],
          }))
        }
        type="button"
      >
        Replace current draft
      </button>
      <span data-testid="context-count">{contextItems.length}</span>
      {composerMounted ? (
        <HomeComposer
          canSubmit
          contextItems={contextItems}
          cwd="/repo"
          defaultModelId="openai/gpt-5"
          draft={draft}
          heroModel=""
          models={MODELS}
          onContextChange={setContextItems}
          onDraftChange={setDraft}
          onHeroModelChange={vi.fn()}
          onSubmit={onSend}
          workspaceId="w1"
        />
      ) : (
        <span data-testid="draft-state">{draft.value}</span>
      )}
    </ImageViewerProvider>
  );
}

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

describe("Composer draft admission", () => {
  it("retains text, image, skill, and context when prompt admission rejects", async () => {
    const user = userEvent.setup();
    let rejectAdmission: (error: Error) => void = () => {};
    const admission = new Promise<void>((_resolve, reject) => {
      rejectAdmission = reject;
    });
    const onSend = vi.fn((..._args: unknown[]) => admission);
    render(<AdmissionHarness onSend={onSend} />);

    await user.click(send());
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend.mock.calls[0]?.[0]).toContain("first prompt");
    expect(onSend.mock.calls[0]?.[3]).toEqual([
      { type: "image", data: "AA==", mimeType: "image/png", name: "mock-image.png" },
    ]);
    expect(onSend.mock.calls[0]?.[4]).toEqual([
      { name: "review", path: "/repo/.modus/skills/review.md" },
    ] satisfies SkillSelection[]);

    rejectAdmission(new Error("Session creation failed"));
    await admission.catch(() => undefined);

    await screen.findByText("Session creation failed");
    expect(screen.getByRole("textbox").textContent).toContain("first prompt");
    expect(screen.getByAltText("mock-image.png")).toBeTruthy();
    expect(screen.getByTestId("context-count").textContent).toBe("1");
  });

  it("admits one prompt at a time and does not erase a newer draft on success", async () => {
    const user = userEvent.setup();
    let resolveAdmission: () => void = () => {};
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    const onSend = vi.fn((..._args: unknown[]) => admission);
    render(<AdmissionHarness onSend={onSend} />);

    await user.click(send());
    expect(screen.getByRole("textbox").textContent).toContain("first prompt");
    expect(send().disabled).toBe(true);
    expect(onSend).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Replace current draft" }));
    resolveAdmission();
    await waitFor(() => expect(screen.getByRole("textbox").textContent).toContain("newer draft"));
    expect(onSend).toHaveBeenCalledOnce();
    expect(screen.getByAltText("mock-image.png")).toBeTruthy();
    expect(screen.getByTestId("context-count").textContent).toBe("1");
  });

  it("clears the accepted host-owned draft when the Composer unmounts during admission", async () => {
    const user = userEvent.setup();
    let resolveAdmission: () => void = () => {};
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    const onSend = vi.fn((..._args: unknown[]) => admission);
    render(<AdmissionHarness onSend={onSend} />);

    await user.click(send());
    await user.click(screen.getByRole("button", { name: "Unmount composer" }));
    expect(screen.getByTestId("draft-state").textContent).toBe("first prompt");

    resolveAdmission();
    await waitFor(() => expect(screen.getByTestId("draft-state").textContent).toBe(""));
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
