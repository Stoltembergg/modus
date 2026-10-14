// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../../../shared/contracts";
import { MessageBlock } from "./MessageBlock";

// These assertions concern the rendered cards, not cold loading of Markdown's
// lazy module. Load the real renderer; do not replace it with a mock.
beforeAll(async () => {
  await import("./MarkdownMessageRenderer");
});
afterEach(cleanup);

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
const SOURCE = { id: "src", kind: "file" as const, label: "app.ts", path: "/repo/app.ts" };

describe("message cards", () => {
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
