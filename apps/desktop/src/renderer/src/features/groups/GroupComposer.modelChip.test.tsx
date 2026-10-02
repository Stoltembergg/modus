// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupComposer } from "./GroupComposer";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

beforeEach(() => {
  Object.assign(window, {
    modus: {
      group: {
        onEvent: vi.fn(() => () => undefined),
        memberStates: vi.fn(async () => []),
      },
    },
  });
});

const members = [
  { sessionId: "lead", title: "Lead" },
  { sessionId: "dev", title: "Dev" },
];
const memberModels = new Map<string, string | undefined>([
  ["lead", "gpt-5"],
  ["dev", undefined],
]);
const models = [{ id: "gpt-5", name: "GPT-5" }];

function renderComposer(onSend = vi.fn(async () => undefined)) {
  render(
    <GroupComposer
      groupId="g-chip"
      leadSessionId="lead"
      locale="en"
      memberModels={memberModels}
      members={members}
      models={models}
      onSend={onSend}
      updatePending={false}
    />,
  );
  return onSend;
}

describe("GroupComposer read-only model chip", () => {
  it("is not rendered without member models (legacy callers)", () => {
    render(<GroupComposer members={members} onSend={vi.fn()} updatePending={false} />);
    expect(screen.queryByTestId("group-model-chip")).toBeNull();
  });

  it("shows the Lead's model by default and follows the mentions in the draft", () => {
    renderComposer();
    const chip = screen.getByTestId("group-model-chip");
    expect(chip.getAttribute("data-kind")).toBe("lead");
    expect(screen.getByTestId("group-model-chip-label").textContent).toBe("GPT-5");
    expect(chip.getAttribute("title")).toBe("Lead answers by default\nLead: GPT-5");
    expect(screen.getByTestId("group-composer-toolbar").contains(chip)).toBe(true);

    const textarea = screen.getByLabelText("Message the group");
    fireEvent.change(textarea, { target: { value: "@Dev fix the bug" } });
    expect(screen.getByTestId("group-model-chip").getAttribute("data-kind")).toBe("single");
    expect(screen.getByTestId("group-model-chip-label").textContent).toBe("Default model");

    fireEvent.change(textarea, { target: { value: "@Dev and @Lead" } });
    expect(screen.getByTestId("group-model-chip-label").textContent).toBe("2 models");
    expect(screen.getByTestId("group-model-chip").getAttribute("title")).toBe(
      // Member order, exactly like the runtime's parseGroupMentions.
      "Lead: GPT-5\nDev: Default model",
    );
  });

  it("is not interactive: no button, no tab stop, clicking does nothing", () => {
    const onSend = renderComposer();
    const chip = screen.getByTestId("group-model-chip");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.closest("button")).toBeNull();
    expect(chip.querySelector("button")).toBeNull();
    expect(chip.getAttribute("role")).toBeNull();
    expect(chip.hasAttribute("tabindex")).toBe(false);
    expect(chip.hasAttribute("aria-haspopup")).toBe(false);
    const before = document.body.innerHTML;
    fireEvent.click(chip);
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(document.body.innerHTML).toBe(before);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("follows an open thread reply and warns in amber when nobody would answer", () => {
    const { rerender } = render(
      <GroupComposer
        groupId="g-chip-reply"
        leadSessionId="lead"
        locale="pt-BR"
        memberModels={memberModels}
        members={members}
        models={models}
        onSend={vi.fn()}
        replyAuthorSessionId="dev"
        replyTo={{ messageId: "m1", preview: "done" }}
        updatePending={false}
      />,
    );
    const chip = () => screen.getByTestId("group-model-chip");
    expect(chip().getAttribute("data-kind")).toBe("reply");
    expect(screen.getByTestId("group-model-chip-label").textContent).toBe("Modelo padrão");
    // Without an open reply the author is ignored (nothing sends replyToMessageId).
    rerender(
      <GroupComposer
        groupId="g-chip-reply"
        leadSessionId="lead"
        locale="pt-BR"
        memberModels={memberModels}
        members={members}
        models={models}
        onSend={vi.fn()}
        replyAuthorSessionId="dev"
        updatePending={false}
      />,
    );
    expect(chip().getAttribute("data-kind")).toBe("lead");
    // Coordinator mode with an archived Lead: amber "Lead arquivado".
    rerender(
      <GroupComposer
        archivedSessionIds={new Set(["lead"])}
        groupId="g-chip-reply"
        leadSessionId="lead"
        locale="pt-BR"
        memberModels={memberModels}
        members={members}
        mode="coordinator"
        models={models}
        onSend={vi.fn()}
        updatePending={false}
      />,
    );
    expect(chip().getAttribute("data-kind")).toBe("nobody");
    expect(chip().hasAttribute("data-warning")).toBe(true);
    expect(chip().className).toContain("text-amber-400");
    // No competing neutral tone (cn does not merge classes).
    expect(chip().className).not.toContain("text-fg-muted");
    expect(screen.getByTestId("group-model-chip-label").textContent).toBe("Lead arquivado");
    expect(chip().getAttribute("title")).toBe(
      "Ninguém vai responder. Mencione um membro ativo ou desarquive o Lead",
    );
    expect(chip().tagName).toBe("SPAN");
    expect(chip().hasAttribute("tabindex")).toBe(false);
  });

  it("still sends the mention text unchanged", () => {
    const onSend = renderComposer();
    fireEvent.change(screen.getByLabelText("Message the group"), {
      target: { value: "@Dev ship it" },
    });
    fireEvent.click(screen.getByLabelText("Send"));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "@Dev ship it" }));
  });
});
