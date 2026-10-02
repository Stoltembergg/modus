// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchToolCard } from "./SearchToolCard";
import { ToolCard } from "./ToolCard";

afterEach(() => cleanup());

const fallback = <div data-testid="generic">generic</div>;
const grepOut =
  "src/very/long/path/to/some/deeply/nested/module/folder/with/more/levels/Thing.tsx:12: x\nsrc/b.ts:1: y\nsrc/b.ts:9: z";

describe("SearchToolCard", () => {
  it("shows the searching state with the query in mono", () => {
    render(
      <SearchToolCard args={{ pattern: "useThing" }} fallback={fallback} name="grep" output="" />,
    );
    expect(screen.getByText("Searching…")).toBeTruthy();
    const query = screen.getByText("useThing");
    expect(query.className).toContain("font-mono");
    expect(document.querySelector("[data-search-state]")?.getAttribute("data-search-state")).toBe(
      "searching",
    );
  });

  it("shows 'Found N results' and expands to file rows with match count / line", () => {
    render(
      <SearchToolCard
        args={{ pattern: "useThing" }}
        fallback={fallback}
        isComplete
        name="grep"
        output={grepOut}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Found 2 results/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Searched for")).toBeTruthy();
    const rows = document.querySelectorAll("[data-search-row='file']");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("title")).toBe(
      "src/very/long/path/to/some/deeply/nested/module/folder/with/more/levels/Thing.tsx",
    );
    expect(rows[0]?.textContent).toContain("…");
    expect(rows[0]?.textContent).toContain("/Thing.tsx");
    expect(rows[0]?.textContent).toContain("L12");
    // The filename sits in its own non-shrinking span so CSS never clips it.
    const pathLabel = rows[0]?.querySelector("[data-search-path]");
    expect(pathLabel?.lastElementChild?.textContent).toBe("Thing.tsx");
    expect(pathLabel?.lastElementChild?.className).toContain("shrink-0");
    expect(rows[1]?.textContent).toContain("2 matches");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders web results as title + source", () => {
    render(
      <SearchToolCard
        args={{ query: "react docs" }}
        defaultOpen
        fallback={fallback}
        isComplete
        name="web_search"
        output={"Title: Learn React\nURL: https://react.dev/learn"}
      />,
    );
    expect(screen.getByText("Found 1 result")).toBeTruthy();
    expect(screen.getByText("Learn React")).toBeTruthy();
    expect(screen.getByText("react.dev")).toBeTruthy();
  });

  it("is not expandable with zero results", () => {
    render(
      <SearchToolCard
        args={{ pattern: "nope" }}
        fallback={fallback}
        isComplete
        name="grep"
        output="No matches found"
      />,
    );
    expect(screen.getByText("Found 0 results")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("falls back to the generic card on errors or unparseable output", () => {
    render(
      <SearchToolCard
        args={{ pattern: "x" }}
        fallback={fallback}
        isComplete
        isError
        name="grep"
        output="boom"
      />,
    );
    expect(screen.getByTestId("generic")).toBeTruthy();
    cleanup();
    render(
      <SearchToolCard
        args={{ query: "x" }}
        fallback={fallback}
        isComplete
        name="web_search"
        output="free prose without links"
      />,
    );
    expect(screen.getByTestId("generic")).toBeTruthy();
  });
});

describe("ToolCard routing", () => {
  it("routes grep to the Search Tool card", () => {
    render(<ToolCard args={{ pattern: "foo" }} isComplete name="grep" output="a.ts:3: foo" />);
    expect(screen.getByRole("button", { name: /Found 1 result/ })).toBeTruthy();
  });

  it("keeps the generic row (with its full output) when parsing fails", () => {
    render(
      <ToolCard
        args={{ query: "foo" }}
        isComplete
        name="web_search"
        output="Search provider said something unstructured"
      />,
    );
    const row = screen.getByRole("button", { name: /Searched the web/ });
    fireEvent.click(row);
    expect(screen.getByText("Search provider said something unstructured")).toBeTruthy();
  });
});

describe("SearchToolCard clickable rows (C2.1)", () => {
  const cwd = "/repo";
  const multi =
    "a.ts:3: const one = 1;\nb.ts:10: first hit\nb.ts:20: second hit … [truncated]\nb.ts:30:   third hit\nc.ts:5: c";

  function renderGrep(
    onOpenFile = vi.fn(),
    extra: { output?: string; args?: Record<string, unknown>; cwd?: string } = {},
  ) {
    render(
      <SearchToolCard
        args={extra.args ?? { pattern: "hit", path: "src" }}
        cwd={extra.cwd ?? cwd}
        defaultOpen
        fallback={fallback}
        isComplete
        name="grep"
        onOpenFile={onOpenFile}
        output={extra.output ?? multi}
      />,
    );
    return onOpenFile;
  }

  const rowButton = (path: string) =>
    screen.getByRole("button", {
      name: new RegExp(`^Open ${path.replace(".", "\\.")}( at line \\d+)?$`),
    });

  it("clicking a row opens the joined path at the first match line", () => {
    const onOpenFile = renderGrep();
    fireEvent.click(rowButton("a.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/a.ts", 3);
    fireEvent.click(rowButton("b.ts"));
    expect(onOpenFile).toHaveBeenLastCalledWith("/repo/src/b.ts", 10);
  });

  it("rows are buttons: Enter / Space activate them natively", () => {
    renderGrep();
    const row = rowButton("a.ts");
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("type")).toBe("button");
    expect(row.className).toContain("focus-visible:ring-2");
    expect(row.className).toContain("focus-visible:ring-focus-ring/35");
  });

  it("expands and collapses a multi-match file with aria-expanded", () => {
    renderGrep();
    const expand = screen.getByRole("button", { name: "Show 3 matches in b.ts" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-search-matches]")).toBeNull();
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(expand.getAttribute("aria-label")).toBe("Hide 3 matches in b.ts");
    const list = document.getElementById(expand.getAttribute("aria-controls") ?? "");
    expect(list?.hasAttribute("data-search-matches")).toBe(true);
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-search-matches]")).toBeNull();
    // Single-match files have no expand control.
    expect(screen.queryByRole("button", { name: /matches in a\.ts/ })).toBeNull();
  });

  it("renders every match line verbatim (incl. truncation) and each opens its own line", () => {
    const onOpenFile = renderGrep();
    fireEvent.click(screen.getByRole("button", { name: "Show 3 matches in b.ts" }));
    const lines = Array.from(document.querySelectorAll('[data-search-open="match"]'));
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.textContent)).toEqual([
      "10first hit",
      "20second hit … [truncated]",
      "30  third hit",
    ]);
    fireEvent.click(lines[1] as HTMLElement);
    expect(onOpenFile).toHaveBeenLastCalledWith("/repo/src/b.ts", 20);
    fireEvent.click(lines[2] as HTMLElement);
    expect(onOpenFile).toHaveBeenLastCalledWith("/repo/src/b.ts", 30);
  });

  it("ArrowRight / ArrowLeft on a row expand / collapse; ArrowLeft on a match returns to the row", async () => {
    renderGrep();
    const row = rowButton("b.ts");
    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(document.querySelectorAll('[data-search-open="match"]')).toHaveLength(3);
    const match = document.querySelector<HTMLElement>('[data-search-open="match"]');
    match?.focus();
    fireEvent.keyDown(match as HTMLElement, { key: "ArrowLeft" });
    expect(document.querySelector("[data-search-matches]")).toBeNull();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement).toBe(rowButton("b.ts"));
    fireEvent.keyDown(rowButton("b.ts"), { key: "ArrowRight" });
    fireEvent.keyDown(rowButton("b.ts"), { key: "ArrowLeft" });
    expect(document.querySelector("[data-search-matches]")).toBeNull();
  });

  it("Arrow Up / Down move a roving focus across rows and expanded match lines", () => {
    renderGrep();
    const list = document.querySelector("[data-search-list]") as HTMLElement;
    const a = rowButton("a.ts");
    // One tab stop: the first row.
    expect(a.tabIndex).toBe(0);
    expect(rowButton("b.ts").tabIndex).toBe(-1);
    fireEvent.click(screen.getByRole("button", { name: "Show 3 matches in b.ts" }));
    a.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowButton("b.ts"));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).dataset.searchOpen).toBe("match");
    expect(document.activeElement?.textContent).toBe("10first hit");
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
    expect(a.tabIndex).toBe(-1);
    fireEvent.keyDown(list, { key: "End" });
    expect(document.activeElement).toBe(rowButton("c.ts"));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowButton("c.ts"));
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("30  third hit");
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(a);
  });

  it("does not join an absolute grep path again with the path arg", () => {
    const onOpenFile = renderGrep(vi.fn(), { output: "/repo/src/abs.ts:4: x" });
    fireEvent.click(screen.getByRole("button", { name: /^Open \/repo\/src\/abs\.ts at line 4$/ }));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/abs.ts", 4);
  });

  it("a result outside the workspace is a disabled row that shows the path", () => {
    const onOpenFile = renderGrep(vi.fn(), {
      args: { pattern: "x", path: "../other" },
      output: "secret.ts:1: x\nsecret.ts:2: y",
    });
    const row = screen.getByRole("button", { name: "secret.ts (outside the workspace)" });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(row.closest("[data-search-row]")?.getAttribute("title")).toBe(
      "Outside the workspace: /other/secret.ts",
    );
    expect(screen.getByText("outside workspace")).toBeTruthy();
    fireEvent.click(row);
    expect(onOpenFile).not.toHaveBeenCalled();
    // Its matches still expand for reading, but do not open.
    fireEvent.click(screen.getByRole("button", { name: "Show 2 matches in secret.ts" }));
    expect(document.querySelectorAll('[data-search-open="match"]')).toHaveLength(0);
    expect(document.querySelectorAll("[data-search-match]")).toHaveLength(2);
  });

  it("find results open with the path only (no line argument)", () => {
    const onOpenFile = vi.fn();
    render(
      <SearchToolCard
        args={{ pattern: "*.ts" }}
        cwd={cwd}
        defaultOpen
        fallback={fallback}
        isComplete
        name="find"
        onOpenFile={onOpenFile}
        output={"src/a.ts\nsrc/dir/"}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open src/a.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/a.ts");
    expect(onOpenFile.mock.calls[0]).toHaveLength(1);
    // Directories are not openable.
    expect(screen.queryByRole("button", { name: "Open src/dir/" })).toBeNull();
  });

  it("without onOpenFile or cwd the rows stay static (previous behaviour)", () => {
    render(
      <SearchToolCard
        args={{ pattern: "hit" }}
        defaultOpen
        fallback={fallback}
        isComplete
        name="grep"
        output={multi}
      />,
    );
    expect(document.querySelectorAll("[data-search-nav]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-search-row]")).toHaveLength(3);
  });

  it("ToolCard forwards onOpenFile and cwd to the search card", () => {
    const onOpenFile = vi.fn();
    render(
      <ToolCard
        args={{ pattern: "foo" }}
        cwd={cwd}
        isComplete
        name="grep"
        onOpenFile={onOpenFile}
        output="a.ts:3: foo"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Found 1 result/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open a.ts at line 3" }));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/a.ts", 3);
  });
});
