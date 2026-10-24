// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentInfo, ModelInfo } from "../../../../shared/contracts";
import { MessageBlock } from "./MessageBlock";

// These assertions concern the rendered cards, not cold loading of Markdown's
// lazy module. Load the real renderer; do not replace it with a mock.
beforeAll(async () => {
  await import("./MarkdownMessageRenderer");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MODEL: ModelInfo = {
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
};
const AGENT: AgentInfo = {
  id: "judas",
  name: "Judas",
  role: "",
  instructions: "",
  avatarColor: "green",
  avatarFace: "happy",
  avatarShape: "blob",
  avatarSeed: null,
  createdAt: "now",
  updatedAt: "now",
};
const SOURCE = { id: "src", kind: "file" as const, label: "app.ts", path: "/repo/app.ts" };

describe("message cards", () => {
  it("settled assistant messages get a copy button that copies the raw markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const markdown = "Done.\n\n- **Yearly** shows a `2 months free` badge";
    const props = { content: markdown, messageId: "a", messageRole: "assistant" as const };
    const view = render(<MessageBlock {...props} streaming />);
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    view.rerender(<MessageBlock {...props} streaming={false} />);
    const button = screen.getByRole("button", { name: "Copy message" });
    const reveal = button.parentElement?.className ?? "";
    expect(reveal).toContain("group-hover/msg:opacity-100");
    expect(reveal).toContain("group-focus-within/msg:opacity-100");
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
    await waitFor(() => expect(button.dataset.copied).toBe("true"));
  });

  it("shows the stored Agent avatar beside the response and keeps its animation while streaming", async () => {
    const props = {
      assistantAgent: AGENT,
      assistantAgentId: AGENT.id,
      content: "Reply",
      messageId: "a",
      messageRole: "assistant" as const,
    };
    const view = render(<MessageBlock {...props} streaming />);
    const avatar = screen.getByRole("img", { name: "Judas" });
    const card = view.container.querySelector('[data-message-role="assistant"]');
    expect(avatar.parentElement).toBe(card?.parentElement);
    expect(avatar.compareDocumentPosition(card as Node) & 4).toBe(4);
    expect(avatar.getAttribute("data-size")).toBe("24");
    expect(avatar.getAttribute("data-color")).toBe("green");
    expect(avatar.getAttribute("data-shape")).toBe("blob");
    // No stored seed: drawn with the agent id.
    expect(avatar.getAttribute("data-seed")).toBe(AGENT.id);
    expect(avatar.getAttribute("data-state")).toBe("working");
    expect(avatar.getAttribute("data-paused")).not.toBe("true");
    view.rerender(<MessageBlock {...props} streaming={false} content="Reply complete" />);
    expect(screen.getByRole("img", { name: "Judas" })).toBe(avatar);
    expect(avatar.getAttribute("data-state")).toBe("idle");
    expect(avatar.getAttribute("data-paused")).not.toBe("true");
    expect(await screen.findByText("Reply complete")).toBeTruthy();
  });

  it("draws the timeline avatar with the stored avatarSeed (avatarSeed ?? id)", () => {
    render(
      <MessageBlock
        assistantAgent={{ ...AGENT, avatarSeed: "face-calm-40" }}
        assistantAgentId={AGENT.id}
        content="Reply"
        messageId="a"
        messageRole="assistant"
      />,
    );
    expect(screen.getByRole("img", { name: "Judas" }).getAttribute("data-seed")).toBe(
      "face-calm-40",
    );
  });

  it("places the user's badge after the bubble, outside its edit control", () => {
    const { container } = render(<MessageBlock content="Oi" messageId="u" messageRole="user" />);
    const avatar = screen.getByRole("img", { name: "You" });
    const bubble = container.querySelector('[data-message-role="user"]');
    expect(avatar.parentElement).toBe(bubble?.parentElement);
    expect((bubble as Element).compareDocumentPosition(avatar) & 4).toBe(4);
    expect(bubble?.contains(avatar)).toBe(false);
  });

  it("marks each role row and keeps long message content in its own row", () => {
    const { container } = render(
      <>
        <MessageBlock
          content={`Assistant ${"long content ".repeat(20)}\n\n| A | B |\n| - | - |\n| 1 | 2 |`}
          messageId="a"
          messageRole="assistant"
        />
        <MessageBlock
          content={`User ${"long content ".repeat(20)}`}
          messageId="u"
          messageRole="user"
        />
      </>,
    );
    expect(container.querySelector('[data-message-row="assistant"]')).toBeTruthy();
    expect(container.querySelector('[data-message-row="user"]')).toBeTruthy();
    expect(
      container.querySelector(
        '[data-message-row="assistant"] [data-message-role="assistant"] table',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-message-row="user"] [data-message-role="user"]'),
    ).toBeTruthy();
  });

  it("uses Modus for a normal chat and an id-derived Agent avatar when the profile is unavailable", () => {
    const props = { content: "Reply", messageId: "a", messageRole: "assistant" as const };
    const view = render(<MessageBlock {...props} />);
    expect(screen.getByRole("img", { name: "Modus" })).toBeTruthy();
    view.rerender(<MessageBlock {...props} assistantAgentId="missing-profile" />);
    expect(screen.queryByRole("img", { name: "Modus" })).toBeNull();
    expect(screen.getByTestId("agent-avatar").getAttribute("data-paused")).not.toBe("true");
    expect(screen.getByTestId("agent-avatar").getAttribute("data-seed")).toBe("missing-profile");
  });

  it("never labels a different session with stale profile data", () => {
    render(
      <MessageBlock
        assistantAgent={AGENT}
        assistantAgentId="another-agent"
        content="Different conversation"
        messageId="a"
        messageRole="assistant"
      />,
    );
    expect(screen.queryByRole("img", { name: "Judas" })).toBeNull();
    expect(screen.getByRole("img", { name: "Agent" })).toBeTruthy();
  });

  it("keeps an archived profile's avatar recognizable and paused", () => {
    render(
      <MessageBlock
        assistantAgent={{ ...AGENT, archivedAt: "now" }}
        assistantAgentId={AGENT.id}
        content="Historical answer"
        messageId="a"
        messageRole="assistant"
        streaming
      />,
    );
    const avatar = screen.getByRole("img", { name: "Judas" });
    expect(avatar.getAttribute("data-state")).toBe("archived");
    expect(avatar.getAttribute("data-paused")).toBe("true");
  });

  it("gives a short user message its own bubble rather than a full-width Composer surface", () => {
    const { container } = render(<MessageBlock content="Oi" messageId="u" messageRole="user" />);
    const card = container.querySelector('[data-message-role="user"]');
    expect(card?.className).toContain("chat-message-bubble");
    expect(card?.className).not.toContain("composer-glass");
    expect(card?.textContent).toBe("Oi");
  });

  it("shows long user messages without clipping or a sticky overlay in the main chat", () => {
    const content = Array.from({ length: 12 }, (_, i) => `Line ${i}`).join("\n");
    const { container } = render(
      <MessageBlock content={content} messageId="u" messageRole="user" />,
    );
    expect(container.textContent).toBe(content);
    expect(container.querySelector('[class*="max-h-"]')).toBeNull();
    expect(container.querySelector('[class*="overflow-hidden"]')).toBeNull();
    expect(container.querySelector(".message-card-slot")?.className).not.toContain("sticky");
  });

  it("retains bounded sticky cards in compact previews", () => {
    const { container } = render(
      <MessageBlock compactClip content="Preview" messageId="u" messageRole="user" />,
    );
    expect(container.querySelector(".message-card-slot")?.className).toContain("sticky");
    expect(container.querySelector('[class*="max-h-"]')).toBeTruthy();
  });

  it("removes a preview's fade when the same message moves into the main chat", async () => {
    // Happy DOM has no layout. Simulate a measured compact viewport using real
    // useClipFade logic, rather than replacing the hook or its decisions.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(20);
    const props = { content: "Long preview", messageId: "u", messageRole: "user" as const };
    const view = render(<MessageBlock {...props} compactClip />);
    await waitFor(() => expect(view.container.querySelector(".clip-fade")).toBeTruthy());
    view.rerender(<MessageBlock {...props} compactClip={false} />);
    expect(view.container.querySelector(".clip-fade")).toBeNull();
  });

  it("keeps assistant text and source evidence inside the left card", async () => {
    const { container } = render(
      <MessageBlock
        content="Reply summary"
        messageId="a"
        messageRole="assistant"
        sources={[SOURCE]}
      />,
    );
    const card = container.querySelector('[data-message-role="assistant"]');
    expect(card?.className).toContain("chat-message-surface");
    expect(await screen.findByText("Reply summary")).toBeTruthy();
    expect(card?.contains(screen.getByRole("button", { name: "Sources (1)" }))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sources (1)" }));
    expect(await screen.findByText("app.ts")).toBeTruthy();
  });

  it("keeps source-unavailability warnings visible", () => {
    const { container } = render(
      <MessageBlock
        content="Reply"
        messageId="a"
        messageRole="assistant"
        sourceStatus="unavailable"
      />,
    );
    expect(container.querySelector('[data-message-role="assistant"]')?.textContent).toContain(
      "Run sources could not be loaded",
    );
  });

  it("does not paint an empty assistant card before any content or final sources arrive", () => {
    const { container } = render(
      <MessageBlock
        content=""
        messageId="a"
        messageRole="assistant"
        streaming
        sources={[SOURCE]}
      />,
    );
    expect(container.querySelector(".chat-message-bubble")).toBeNull();
    expect(container.firstElementChild).toBeNull();
  });

  it.each([
    { content: "```diff\n-old value\n+new value\n```", selector: "pre", text: "+new value" },
    {
      content: "| Name | Value |\n| --- | --- |\n| Example | Kept |",
      selector: "table",
      text: "Kept",
    },
  ])("preserves technical output ($selector) inside the card", async ({
    content,
    selector,
    text,
  }) => {
    const { container } = render(
      <MessageBlock content={content} messageId="a" messageRole="assistant" />,
    );
    await waitFor(() => expect(container.querySelector(selector)?.textContent).toContain(text));
    const card = container.querySelector('[data-message-role="assistant"]');
    expect(card?.className).not.toMatch(/max-h-|overflow-hidden/);
  });

  it("keeps the open copy menu available beside a genuinely wide table", async () => {
    const columns = Array.from({ length: 12 }, (_, index) => `Column ${index}`);
    const content = [
      `| ${columns.join(" | ")} |`,
      `| ${columns.map(() => "---").join(" | ")} |`,
      `| ${columns.map((_, index) => `wide-cell-${index}-${"x".repeat(24)}`).join(" | ")} |`,
    ].join("\n");
    const { container } = render(
      <MessageBlock content={content} messageId="wide-table" messageRole="assistant" />,
    );
    const wrapper = await waitFor(() => {
      const element = container.querySelector('[data-streamdown="table-wrapper"]');
      expect(element?.querySelector("table th")).toBeTruthy();
      return element as HTMLElement;
    });
    const copyMenuTrigger = wrapper.querySelector("button");
    expect(copyMenuTrigger).toBeTruthy();
    fireEvent.click(copyMenuTrigger as HTMLButtonElement);
    const menu = await waitFor(() => {
      const element = wrapper.querySelector('[class~="top-full"]');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    expect(menu.textContent).toMatch(/Markdown/);
    expect(menu.textContent).toMatch(/CSV/);
    expect(menu.textContent).toMatch(/TSV/);
    for (const format of ["Markdown", "CSV", "TSV"]) {
      const option = within(menu).getByRole("button", { name: format });
      expect((option as HTMLButtonElement).disabled).toBe(false);
      option.focus();
      expect(document.activeElement).toBe(option);
    }
  });

  it("shows final source evidence only after streaming ends", async () => {
    const props = {
      content: "Reply",
      messageId: "a",
      messageRole: "assistant" as const,
      sources: [SOURCE],
    };
    const view = render(<MessageBlock {...props} streaming />);
    expect(screen.queryByRole("button", { name: "Sources (1)" })).toBeNull();
    view.rerender(<MessageBlock {...props} streaming={false} />);
    expect(await screen.findByRole("button", { name: "Sources (1)" })).toBeTruthy();
  });

  it("still opens the full shared Composer for edit-resend", () => {
    const { container } = render(
      <MessageBlock
        content="Edit me"
        editable
        messageId="u"
        messageRole="user"
        model={MODEL.id}
        models={[MODEL]}
        onEditResend={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(container.querySelector('[data-message-role="user"]')).toBeNull();
    expect(container.querySelector(".composer-glass")).toBeTruthy();
    expect(screen.getByRole("textbox").textContent).toContain("Edit me");
  });
});
