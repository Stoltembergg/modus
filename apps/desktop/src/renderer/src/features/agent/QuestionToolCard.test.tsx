// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { QuestionRequest } from "../../../../shared/contracts";
import { QuestionToolCard } from "./QuestionToolCard";

afterEach(() => cleanup());

const request: QuestionRequest = {
  id: "r1",
  questions: [
    {
      id: "q1",
      header: "Which view?",
      multiSelect: false,
      options: [{ label: "Grid" }, { label: "List", recommended: true }],
    },
    { id: "q2", header: "Name?", multiSelect: false, options: [] },
  ],
};

describe("QuestionToolCard (adapter)", () => {
  it("shows Asking… while running", () => {
    render(<QuestionToolCard request={request} />);
    expect(screen.getByText("Asking…")).toBeTruthy();
  });

  it("lists structured answers with the recommended marker", () => {
    render(
      <QuestionToolCard
        answers={[
          { questionId: "q1", selected: ["List"] },
          { questionId: "q2", selected: [], custom: "modus" },
        ]}
        isComplete
        request={request}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Asked 2 questions/ }));
    expect(screen.getByText("List")).toBeTruthy();
    expect(screen.getByText("(Recommended)")).toBeTruthy();
    expect(screen.getByText("modus")).toBeTruthy();
  });

  it("reads questions from args and marks skipped", () => {
    render(<QuestionToolCard args={{ questions: [{ header: "Only one?" }] }} isComplete skipped />);
    fireEvent.click(screen.getByRole("button", { name: /Asked 1 question$/ }));
    expect(screen.getByText("Skipped")).toBeTruthy();
  });
});
