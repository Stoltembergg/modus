import { describe, expect, it } from "vitest";
import { joinCommandLine, splitCommandLine } from "./command-line";

describe("splitCommandLine", () => {
  it("splits on whitespace", () => {
    expect(splitCommandLine("npx -y @scope/server .")).toEqual(["npx", "-y", "@scope/server", "."]);
  });

  it("keeps quoted segments together", () => {
    expect(splitCommandLine('node "C:\\My Tools\\server.js" --flag')).toEqual([
      "node",
      "C:\\My Tools\\server.js",
      "--flag",
    ]);
    expect(splitCommandLine("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  it("handles empty quoted tokens and extra spaces", () => {
    expect(splitCommandLine('cmd  ""   tail')).toEqual(["cmd", "", "tail"]);
    expect(splitCommandLine("   ")).toEqual([]);
  });
});

describe("joinCommandLine", () => {
  it("round-trips simple commands", () => {
    const parts = ["npx", "-y", "@scope/server", "."];
    expect(splitCommandLine(joinCommandLine(parts))).toEqual(parts);
  });

  it("quotes tokens with spaces", () => {
    expect(joinCommandLine(["node", "C:\\My Tools\\server.js"])).toBe(
      'node "C:\\My Tools\\server.js"',
    );
  });

  it("represents empty tokens explicitly", () => {
    expect(joinCommandLine(["a", ""])).toBe('a ""');
  });

  it.each([
    ["double quote", ["npx", 'a"b']],
    ["both quote kinds", ["node", `a"b' c`]],
    ["trailing backslashes", ["node", "C:\\tools\\"]],
    ["tabs and newlines", ["command", "two\tlines\nsecond"]],
    ["unicode", ["npx", "ação 東京 🧭"]],
    ["shell-looking text stays literal", ["node", "$(touch nope)", "${HOME}"]],
  ])("round-trips %s arguments", (_label, parts) => {
    expect(splitCommandLine(joinCommandLine(parts))).toEqual(parts);
  });
});
