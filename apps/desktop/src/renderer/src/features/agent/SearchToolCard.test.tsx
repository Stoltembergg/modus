// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
