// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDetails } from "./QuestionCard";

afterEach(cleanup);

describe("ApprovalDetails", () => {
  it("collapses long payloads, says how many lines are hidden, and can show everything", () => {
    const details = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    render(<ApprovalDetails details={details} />);
    expect(screen.getByTestId("approval-details").textContent).not.toContain("line 99");
    const toggle = screen.getByTestId("approval-details-show-all");
    expect(toggle.textContent).toBe("Show all (60 more lines)");
    fireEvent.click(toggle);
    expect(screen.getByTestId("approval-details").textContent).toContain("line 99");
  });

  it("shows short payloads in full with no collapse control", () => {
    render(<ApprovalDetails details={"a\nb"} />);
    expect(screen.queryByTestId("approval-details-show-all")).toBeNull();
  });
});
