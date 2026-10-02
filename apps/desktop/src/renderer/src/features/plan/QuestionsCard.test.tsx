// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionRequest } from "../../../../shared/contracts";
import { QuestionsCard } from "./QuestionsCard";

afterEach(() => cleanup());

const request: QuestionRequest = {
  id: "r1",
  questions: [
    {
      id: "q1",
      header: "Which view?",
      multiSelect: false,
      options: [{ label: "A" }, { label: "B", recommended: true }],
    },
  ],
};

describe("QuestionsCard (adapter)", () => {
  it("submits QuestionAnswer[] payloads", () => {
    const onSubmit = vi.fn();
    render(<QuestionsCard onSkip={vi.fn()} onSubmit={onSubmit} request={request} />);
    fireEvent.change(screen.getByPlaceholderText("Or type a different answer…"), {
      target: { value: "C" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: "q1", selected: ["B"], custom: "C" }]);
  });

  it("skips via Dismiss", () => {
    const onSkip = vi.fn();
    render(<QuestionsCard onSkip={onSkip} onSubmit={vi.fn()} request={request} />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
