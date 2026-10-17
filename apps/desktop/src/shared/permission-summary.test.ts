import { describe, expect, it } from "vitest";
import { describeToolCall, editDiff, REA_APPROVAL_NOTICE } from "./permission-summary";

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

describe("describeToolCall for REA", () => {
  it("rea_call says it runs npm code with the user's permissions, not in a sandbox", () => {
    const input = { operation: "inspect_native_load_image", arguments: { path: "a.bin" } };
    const result = describeToolCall("rea_call", input);
    expect(result.summary).toBe(
      "Run REA operation inspect_native_load_image. REA runs rea-agents code from npm (downloaded on first use) on this computer with your permissions. It is not a sandbox.",
    );
    expect(result.details).toBe(JSON.stringify(input, null, 2));
  });

  it("rea_tools carries the same notice", () => {
    const result = describeToolCall("rea_tools", { query: "pe" });
    expect(result.summary.startsWith("List REA operations. ")).toBe(true);
    expect(result.summary).toContain(REA_APPROVAL_NOTICE);
  });

  it("the notice names npm, downloading, the user's permissions and no sandbox", () => {
    expect(REA_APPROVAL_NOTICE).toMatch(/npm/);
    expect(REA_APPROVAL_NOTICE).toMatch(/downloaded/);
    expect(REA_APPROVAL_NOTICE).toMatch(/your permissions/);
    expect(REA_APPROVAL_NOTICE).toMatch(/not a sandbox/);
    expect(REA_APPROVAL_NOTICE.length).toBeLessThan(160);
  });

  it("rea_call without an operation still shows the notice", () => {
    expect(describeToolCall("rea_call", {}).summary).toContain(REA_APPROVAL_NOTICE);
  });
});
