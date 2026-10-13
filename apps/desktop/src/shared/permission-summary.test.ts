import { describe, expect, it } from "vitest";
import { describeToolCall, editDiff } from "./permission-summary";

describe("describeToolCall for file writes and edits", () => {
  it("write shows the exact full file content in details", () => {
    const content = "line 1\nline 2\n- not a diff\n";
    const result = describeToolCall("write", { path: "src/a.ts", content });
    expect(result.summary).toBe("Write file src/a.ts");
    expect(result.details).toBe(content);
  });

  it("edit shows a single diff with removed and added lines", () => {
    const result = describeToolCall("edit", {
      path: "src/a.ts",
      oldText: "const a = 1;\nconst b = 2;",
      newText: "const a = 3;",
    });
    expect(result.summary).toBe("Edit file src/a.ts");
    expect(result.details).toBe("@@\n-const a = 1;\n-const b = 2;\n+const a = 3;");
  });

  it("edit with several replacements lists every one", () => {
    const details = editDiff({
      path: "x",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    });
    expect(details).toBe("@@\n-a\n+b\n@@\n-c\n+d");
  });

  it("edit never truncates large content", () => {
    const oldText = Array.from({ length: 500 }, (_, i) => `old ${i}`).join("\n");
    const result = describeToolCall("edit", { path: "big.ts", oldText, newText: "x" });
    expect(result.details?.split("\n")).toHaveLength(1 + 500 + 1);
  });
});
