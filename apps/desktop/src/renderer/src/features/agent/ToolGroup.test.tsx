// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkActivityRow, WorkFold, workActivityStreamCounts } from "./ActivityGroup";
import type { GroupedWorkActivityItem, RunBlockItem, WorkFoldItem } from "./Timeline";
import { ToolGroup } from "./ToolGroup";

afterEach(() => cleanup());

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: static fixture rows
    <div data-row key={i}>
      row {i}
    </div>
  ));

describe("ToolGroup", () => {
  it("starts collapsed and toggles open", () => {
    let open = false;
    const { rerender } = render(
      <ToolGroup label="Read 2 files" onToggle={() => (open = !open)} open={open}>
        {rows(2)}
      </ToolGroup>,
    );
    const toggle = screen.getByRole("button", { name: /Read 2 files/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll("[data-row]")).toHaveLength(0);
    fireEvent.click(toggle);
    rerender(
      <ToolGroup label="Read 2 files" onToggle={() => (open = !open)} open={open}>
        {rows(2)}
      </ToolGroup>,
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll("[data-row]")).toHaveLength(2);
  });

  it("windows the list with a top mask only while streaming with many rows", () => {
    const { rerender } = render(
      <ToolGroup active detail="2 files" label="Searching" onToggle={() => {}} open>
        {rows(6)}
      </ToolGroup>,
    );
    expect(document.querySelector("[data-tool-group]")?.getAttribute("data-tool-group")).toBe(
      "streaming",
    );
    expect(screen.getByText("2 files")).toBeTruthy();
    expect(document.querySelector("[data-tool-group-mask]")).toBeTruthy();
    expect((document.querySelector("[data-tool-group-list]") as HTMLElement).style.maxHeight).toBe(
      "220px",
    );
    rerender(
      <ToolGroup label="Read 6 files" onToggle={() => {}} open>
        {rows(6)}
      </ToolGroup>,
    );
    expect(document.querySelector("[data-tool-group-mask]")).toBeNull();
    expect(document.querySelector("[data-tool-group]")?.getAttribute("data-tool-group")).toBe(
      "settled",
    );
  });
});

const tool = (id: string, name: string, args: unknown, done = true): GroupedWorkActivityItem => ({
  id,
  type: "tool",
  name,
  args,
  output: name === "grep" ? "a.ts:1: x" : "",
  ...(done ? { isComplete: true } : {}),
});

describe("work activity group (ActivityGroup + ToolGroup)", () => {
  it("counts distinct files and searches for the streaming detail", () => {
    expect(
      workActivityStreamCounts([
        tool("1", "read", { path: "a.ts" }),
        tool("2", "read", { path: "a.ts" }),
        tool("3", "edit", { path: "b.ts" }),
        tool("4", "grep", { pattern: "x" }),
        tool("5", "bash", { command: "ls" }),
      ]),
    ).toBe("2 files, 1 search");
    expect(workActivityStreamCounts([tool("1", "bash", { command: "ls" })])).toBe("");
  });

  it("renders a streaming group collapsed with counts, nested tools via ToolCard", () => {
    const run: RunBlockItem = {
      id: "run",
      type: "run",
      runId: "run",
      status: "running",
      startedAt: Date.now(),
    };
    const items: WorkFoldItem[] = [
      {
        id: "g",
        type: "work-activity-group",
        items: [tool("1", "read", { path: "a.ts" }), tool("2", "grep", { pattern: "x" }, false)],
      },
    ];
    render(<WorkFold items={items} run={run} />);
    const group = screen.getByRole("button", { name: /Searching x/ });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("1 file, 1 search")).toBeTruthy();
    fireEvent.click(group);
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Searching…")).toBeTruthy();
  });

  it("settled group shows the summary label and no streaming detail", () => {
    const run: RunBlockItem = {
      id: "run",
      type: "run",
      runId: "run",
      status: "completed",
      startedAt: 0,
      completedAt: 1000,
    };
    const items: WorkFoldItem[] = [
      {
        id: "g",
        type: "work-activity-group",
        items: [tool("1", "read", { path: "a.ts" }), tool("2", "read", { path: "b.ts" })],
      },
    ];
    render(<WorkFold items={items} run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand work" }));
    const group = screen.getByRole("button", { name: /Read 2 files/ });
    expect(document.querySelector("[data-tool-group-detail]")).toBeNull();
    expect(group.getAttribute("aria-expanded")).toBe("false");
  });

  it("WorkActivityRow still renders non-search tools through ToolCard", () => {
    render(<WorkActivityRow item={tool("1", "read", { path: "src/a.ts" })} />);
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });
});
