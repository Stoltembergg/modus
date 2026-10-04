// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModusUnavailableNotice } from "./ModusUnavailableNotice";

afterEach(() => cleanup());

describe("L3b0 ModusUnavailableNotice", () => {
  it("shows inline (no modal) for a Modus session while Modus is unavailable", () => {
    render(
      <ModusUnavailableNotice
        modelIds={["openai/gpt-x", "modus/deepseek/deepseek-flash"]}
        status="unavailable"
      />,
    );
    const notice = screen.getByTestId("modus-unavailable-notice");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toMatch(/Modus is unavailable right now/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not show for an own-provider session, nor when Modus is ready or off", () => {
    const { rerender } = render(
      <ModusUnavailableNotice modelIds={["openai/gpt-x", undefined]} status="unavailable" />,
    );
    expect(screen.queryByTestId("modus-unavailable-notice")).toBeNull();
    rerender(<ModusUnavailableNotice modelIds={["modus/zai/glm"]} status="ready" />);
    expect(screen.queryByTestId("modus-unavailable-notice")).toBeNull();
    rerender(<ModusUnavailableNotice modelIds={["modus/zai/glm"]} status={undefined} />);
    expect(screen.queryByTestId("modus-unavailable-notice")).toBeNull();
  });
});
