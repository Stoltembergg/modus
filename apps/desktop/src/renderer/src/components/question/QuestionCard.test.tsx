// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionPrompt } from "../../../../shared/contracts";
import { type ApprovalChoice, QuestionCard } from "./QuestionCard";

afterEach(() => cleanup());

const single: QuestionPrompt = {
  id: "view",
  header: "Which view?",
  detail: "Pick one",
  multiSelect: false,
  options: [{ label: "Grid" }, { label: "List", recommended: true }, { label: "Board" }],
};
const multi: QuestionPrompt = {
  id: "langs",
  header: "Which languages?",
  multiSelect: true,
  options: [{ label: "TS" }, { label: "Rust" }, { label: "Go" }],
};
const text: QuestionPrompt = {
  id: "name",
  header: "Project name?",
  multiSelect: false,
  options: [],
};

const choices: ApprovalChoice[] = [
  { id: "yes", key: "1", title: "Yes" },
  { id: "always", key: "2", title: "Always" },
  { id: "no", key: "3", title: "No" },
];

function card(): HTMLElement {
  return screen.getByRole("region");
}

describe("QuestionCard — question mode", () => {
  it("single choice starts on the recommended option and submits the selection", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard mode="question" onSkip={vi.fn()} onSubmit={onSubmit} questions={[single]} />,
    );
    expect(card().dataset.kind).toBe("single");
    expect(screen.getByRole("button", { name: /List/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Board/ }));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: "view", selected: ["Board"] }]);
  });

  it("supports keyboard: digits, arrows (radio), Enter submits, focus on mount", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard mode="question" onSkip={vi.fn()} onSubmit={onSubmit} questions={[single]} />,
    );
    expect(document.activeElement).toBe(card());
    fireEvent.keyDown(card(), { key: "1" });
    fireEvent.keyDown(card(), { key: "ArrowDown" });
    fireEvent.keyDown(card(), { key: "ArrowDown" });
    fireEvent.keyDown(card(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: "view", selected: ["Board"] }]);
  });

  it("multi choice toggles options and sends custom text alongside", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard mode="question" onSkip={vi.fn()} onSubmit={onSubmit} questions={[multi]} />,
    );
    expect(card().dataset.kind).toBe("multi");
    fireEvent.click(screen.getByRole("button", { name: /TS/ }));
    fireEvent.click(screen.getByRole("button", { name: /Go/ }));
    fireEvent.keyDown(card(), { key: "1" }); // toggles TS off
    fireEvent.keyDown(card(), { key: "2" }); // toggles Rust on
    fireEvent.change(screen.getByLabelText("Other answer"), { target: { value: "  Zig " } });
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: "langs", selected: ["Go", "Rust"], custom: "Zig" },
    ]);
  });

  it("free text (no options) submits the typed answer; Enter works while typing", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard mode="question" onSkip={vi.fn()} onSubmit={onSubmit} questions={[text]} />,
    );
    expect(card().dataset.kind).toBe("text");
    const input = screen.getByLabelText("Your answer");
    fireEvent.change(input, { target: { value: "modus" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: "name", selected: [], custom: "modus" }]);
  });

  it("paginates across questions and submits all answers on the last page", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard
        mode="question"
        onSkip={vi.fn()}
        onSubmit={onSubmit}
        questions={[single, multi, text]}
      />,
    );
    expect(screen.getByText("1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Next ⏎$/ }));
    expect(screen.getByText("Which languages?")).toBeTruthy();
    fireEvent.keyDown(card(), { key: "3" });
    fireEvent.keyDown(card(), { key: "ArrowRight" });
    expect(screen.getByText("Project name?")).toBeTruthy();
    fireEvent.keyDown(card(), { key: "ArrowLeft" });
    expect(screen.getByText("2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: "view", selected: ["List"] },
      { questionId: "langs", selected: ["Go"] },
      { questionId: "name", selected: [] },
    ]);
  });

  it("Escape and Dismiss skip", () => {
    const onSkip = vi.fn();
    render(
      <QuestionCard mode="question" onSkip={onSkip} onSubmit={vi.fn()} questions={[single]} />,
    );
    fireEvent.keyDown(card(), { key: "Escape" });
    expect(onSkip).toHaveBeenCalledTimes(1);
    cleanup();
    const onSkip2 = vi.fn();
    render(
      <QuestionCard mode="question" onSkip={onSkip2} onSubmit={vi.fn()} questions={[single]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(onSkip2).toHaveBeenCalledTimes(1);
  });

  it("is disabled after answering: no double submit, controls disabled", () => {
    const onSubmit = vi.fn();
    const onSkip = vi.fn();
    render(
      <QuestionCard mode="question" onSkip={onSkip} onSubmit={onSubmit} questions={[single]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    fireEvent.keyDown(card(), { key: "Enter" });
    fireEvent.keyDown(card(), { key: "Escape" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
    expect(card().dataset.status).toBe("answered");
    expect(screen.getByText("Answered")).toBeTruthy();
    for (const button of screen.getAllByRole("button")) {
      if (/question/.test(button.getAttribute("aria-label") ?? "")) continue;
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByLabelText("Other answer") as HTMLInputElement).disabled).toBe(true);
  });

  it("re-enables and shows the error when the submit promise rejects", async () => {
    const onSubmit = vi.fn(() => Promise.reject(new Error("ipc down")));
    render(
      <QuestionCard mode="question" onSkip={vi.fn()} onSubmit={onSubmit} questions={[single]} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("ipc down"));
    expect((screen.getByRole("button", { name: /Submit/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("expired status is read-only", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard
        mode="question"
        onSkip={vi.fn()}
        onSubmit={onSubmit}
        questions={[single]}
        status="expired"
      />,
    );
    expect(screen.getByText("Expired")).toBeTruthy();
    fireEvent.keyDown(card(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("QuestionCard — approval mode", () => {
  function renderApproval(onDecide = vi.fn(), extra: { allowReason?: boolean } = {}) {
    render(
      <QuestionCard
        badge="shell.execute"
        choices={choices}
        defaultChoice="yes"
        denyChoice="no"
        mode="approval"
        onDecide={onDecide}
        reason="Needs to run tests"
        target="npm test"
        title="Allow running this command?"
        {...extra}
      />,
    );
    return onDecide;
  }

  it("Approve sends the selected (default) choice", async () => {
    const onDecide = renderApproval();
    expect(screen.getByRole("region", { name: "Tool approval" })).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    });
    expect(onDecide).toHaveBeenCalledWith("yes");
  });

  it("Deny and Escape send the deny choice", async () => {
    const onDecide = renderApproval();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
    });
    expect(onDecide).toHaveBeenCalledWith("no");
    cleanup();
    const onDecide2 = renderApproval();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" });
    });
    expect(onDecide2).toHaveBeenCalledWith("no");
  });

  it("digit keys pick a choice and Enter submits it", async () => {
    const onDecide = renderApproval();
    fireEvent.keyDown(screen.getByRole("region"), { key: "2" });
    expect(screen.getByRole("button", { name: /Always/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("region"), { key: "Enter" });
    });
    expect(onDecide).toHaveBeenCalledWith("always");
  });

  it("passes the optional reason when enabled", async () => {
    const onDecide = renderApproval(vi.fn(), { allowReason: true });
    const input = screen.getByLabelText("Reason (optional)");
    fireEvent.change(input, { target: { value: "not now" } });
    fireEvent.keyDown(input, { key: "3" }); // typing digits does not change the choice
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
    });
    expect(onDecide).toHaveBeenCalledWith("no", "not now");
  });

  it("locks while deciding and re-enables on failure", async () => {
    let reject!: (error: Error) => void;
    const onDecide = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    renderApproval(onDecide);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    });
    expect(screen.getByText("Submitting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    await act(async () => {
      reject(new Error("nope"));
    });
    expect(screen.getByRole("alert").textContent).toBe("nope");
    expect((screen.getByRole("button", { name: /Deny/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("QuestionCard — summary mode", () => {
  it("renders the in-flight line", () => {
    render(<QuestionCard items={[]} mode="summary" running />);
    expect(screen.getByText("Asking…")).toBeTruthy();
  });

  it("collapses to 'Asked N questions' and expands the answers", () => {
    render(
      <QuestionCard
        items={[
          { id: "a", header: "Which view?", answer: "List", recommended: true },
          { id: "b", header: "Name?", answer: "" },
        ]}
        mode="summary"
      />,
    );
    const toggle = screen.getByRole("button", { name: /Asked 2 questions/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Which view?")).toBeTruthy();
    expect(screen.getByText("(Recommended)")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });
});
