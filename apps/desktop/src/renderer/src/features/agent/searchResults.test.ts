import { describe, expect, it } from "vitest";
import {
  fileResultMeta,
  isSearchToolName,
  middleTruncatePath,
  parseFindOutput,
  parseGrepOutput,
  parseSearchOutput,
  parseWebSearchOutput,
  searchQuery,
} from "./searchResults";

describe("middleTruncatePath", () => {
  it("leaves short paths alone", () => {
    expect(middleTruncatePath("src/a.ts", 64)).toBe("src/a.ts");
  });

  it("cuts the middle of the directory and keeps the filename", () => {
    const path = "apps/desktop/src/renderer/src/components/question/deeply/nested/QuestionCard.tsx";
    const out = middleTruncatePath(path, 48);
    expect(out.length).toBe(48);
    expect(out.endsWith("/QuestionCard.tsx")).toBe(true);
    expect(out.startsWith("apps/desk")).toBe(true);
    expect(out).toContain("…");
  });

  it("keeps the tail of a filename longer than the budget", () => {
    const out = middleTruncatePath(`dir/${"x".repeat(80)}.ts`, 20);
    expect(out).toHaveLength(20);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith(".ts")).toBe(true);
  });
});

describe("parseGrepOutput", () => {
  it("groups matches per file with count and first line", () => {
    const parsed = parseGrepOutput(
      [
        "src/a.ts:12: const a = 1;",
        "src/a.ts-13- context",
        "src/a.ts:40: a again",
        "src/my-file.ts-2- before",
        "src/my-file.ts:3: hit",
      ].join("\n"),
    );
    expect(parsed?.results).toEqual([
      { kind: "file", path: "src/a.ts", matches: 2, line: 12 },
      { kind: "file", path: "src/my-file.ts", matches: 1, line: 3 },
    ]);
  });

  it("keeps the trailing notice and handles the empty output", () => {
    expect(parseGrepOutput("a.ts:1: x\n\n[100 matches limit reached]")).toEqual({
      results: [{ kind: "file", path: "a.ts", matches: 1, line: 1 }],
      notice: "100 matches limit reached",
    });
    expect(parseGrepOutput("No matches found")).toEqual({ results: [] });
  });

  it("returns undefined for unrecognised output", () => {
    expect(parseGrepOutput("ripgrep exploded")).toBeUndefined();
    expect(parseGrepOutput("")).toBeUndefined();
  });
});

describe("parseFindOutput", () => {
  it("lists paths and the notice", () => {
    expect(parseFindOutput("src/a.ts\nsrc/b/\n\n[50 results limit reached]")).toEqual({
      results: [
        { kind: "file", path: "src/a.ts" },
        { kind: "file", path: "src/b/" },
      ],
      notice: "50 results limit reached",
    });
    expect(parseFindOutput("No files found matching pattern")).toEqual({ results: [] });
    expect(parseFindOutput("Error: fd not found")).toBeUndefined();
  });
});

describe("parseWebSearchOutput", () => {
  it("reads Title/URL blocks", () => {
    const parsed = parseWebSearchOutput(
      "Title: React docs\nURL: https://www.react.dev/learn\nText: ...\n\nTitle: MDN\nURL: https://developer.mozilla.org/x",
    );
    expect(parsed?.results).toEqual([
      { kind: "web", title: "React docs", url: "https://www.react.dev/learn", source: "react.dev" },
      {
        kind: "web",
        title: "MDN",
        url: "https://developer.mozilla.org/x",
        source: "developer.mozilla.org",
      },
    ]);
  });

  it("reads JSON and markdown links, else undefined", () => {
    expect(
      parseWebSearchOutput('{"results":[{"title":"A","url":"https://a.dev/1"}]}')?.results,
    ).toEqual([{ kind: "web", title: "A", url: "https://a.dev/1", source: "a.dev" }]);
    expect(parseWebSearchOutput("1. [B](https://b.dev/x)")?.results).toEqual([
      { kind: "web", title: "B", url: "https://b.dev/x", source: "b.dev" },
    ]);
    expect(parseWebSearchOutput("just some prose")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("formats match count / line", () => {
    expect(fileResultMeta({ kind: "file", path: "a", matches: 1, line: 7 })).toBe("L7");
    expect(fileResultMeta({ kind: "file", path: "a", matches: 3, line: 7 })).toBe("3 matches");
    expect(fileResultMeta({ kind: "file", path: "a" })).toBe("");
    expect(fileResultMeta({ kind: "file", path: "a/" })).toBe("dir");
  });

  it("knows the search tools and their query", () => {
    expect(["grep", "find", "web_search"].every(isSearchToolName)).toBe(true);
    expect(isSearchToolName("read")).toBe(false);
    expect(searchQuery("grep", { pattern: "foo", glob: "*.ts" })).toBe("foo in *.ts");
    expect(searchQuery("find", { pattern: "*.md", path: "docs" })).toBe("*.md in docs");
    expect(searchQuery("web_search", { query: "react 19" })).toBe("react 19");
    expect(parseSearchOutput("read", "x")).toBeUndefined();
  });
});
