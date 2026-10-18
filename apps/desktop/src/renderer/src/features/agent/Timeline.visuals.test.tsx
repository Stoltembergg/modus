// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline, type ToolBlockItem } from "./Timeline";
import { splitTimelinePresentation } from "./timelinePresentation";

afterEach(cleanup);

describe("visual results in the conversation", () => {
  it("renders the existing visual viewer in chat and only a tool summary in Activity", () => {
    const picture: ToolBlockItem = {
      id: "picture",
      type: "tool",
      name: "visual_write",
      args: { title: "Sleeping dog", kind: "svg", content: "<svg><circle r='10'/></svg>" },
      output: "Rendered visual: Sleeping dog",
      isComplete: true,
    };
    const { transcriptBlocks, activityBlocks } = splitTimelinePresentation([picture]);
    const view = render(<Timeline blocks={transcriptBlocks} />);

    expect(view.container.querySelectorAll("iframe")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("menuitem", { name: "Download file" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Open fullscreen" })).toBeTruthy();

    // Same mounted component: the memoized tool card must switch presentation.
    view.rerender(<Timeline blocks={activityBlocks} />);
    expect(view.container.querySelectorAll("iframe")).toHaveLength(0);
    expect(screen.getByText("Sleeping dog")).toBeTruthy();

    view.rerender(<Timeline blocks={transcriptBlocks} />);
    expect(view.container.querySelectorAll("iframe")).toHaveLength(1);
  });
});
