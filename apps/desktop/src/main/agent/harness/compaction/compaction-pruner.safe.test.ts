import { describe, expect, it } from "vitest";
import { pruneDuplicateToolResults } from "./compaction-pruner";

function toolResult(
  text: string,
  options: {
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    content?: unknown[];
    details?: unknown;
  } = {},
) {
  return {
    role: "toolResult",
    toolName: options.toolName ?? "read",
    toolCallId: options.toolCallId ?? crypto.randomUUID(),
    content: options.content ?? [{ type: "text", text }],
    ...(options.details !== undefined ? { details: options.details } : {}),
    isError: options.isError ?? false,
    timestamp: Date.now(),
  };
}

describe("safe duplicate tool-result pruning", () => {
  it("prunes an earlier exact read-only result and keeps the later copy and tool envelope", () => {
    const text = "interface Alpha { value: number; }\n".repeat(80);
    const first = toolResult(text, { toolCallId: "first-call" });
    const later = toolResult(text, { toolCallId: "later-call" });
    const original = [first, later];

    const result = pruneDuplicateToolResults(original);

    expect(result.prunedCount).toBe(1);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      role: "toolResult",
      toolName: "read",
      toolCallId: "first-call",
      isError: false,
    });
    expect(result.messages[0]?.content).not.toEqual(first.content);
    expect(result.messages[0]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/identical later result/i),
    });
    expect(result.messages[1]).toEqual(later);
    expect(first.content[0]).toMatchObject({ type: "text", text });
    expect(result.messages).not.toBe(original);
  });

  it("reports the serialized byte delta and labels token savings as an estimate", () => {
    const text = "stable informational output\n".repeat(100);
    const messages = [toolResult(text), toolResult(text)];
    const beforeBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");

    const result = pruneDuplicateToolResults(messages);

    const afterBytes = Buffer.byteLength(JSON.stringify(result.messages), "utf8");
    expect(result.measuredContextBytesRemoved).toBe(beforeBytes - afterBytes);
    expect(result.measuredContextBytesRemoved).toBeGreaterThan(0);
    expect(result.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it.each([
    [
      "different tool",
      [
        toolResult("same body", { toolName: "read" }),
        toolResult("same body", { toolName: "grep" }),
      ],
    ],
    ["different text", [toolResult("first body"), toolResult("later body")]],
    ["only one result", [toolResult("single body")]],
    ["an error result", [toolResult("same body", { isError: true }), toolResult("same body")]],
    [
      "unknown tool",
      [
        toolResult("same body", { toolName: "custom_lookup" }),
        toolResult("same body", { toolName: "custom_lookup" }),
      ],
    ],
    [
      "mutating tool",
      [
        toolResult("same body", { toolName: "write" }),
        toolResult("same body", { toolName: "write" }),
      ],
    ],
    [
      "QA evidence",
      [toolResult("Vitest check passed: 14 tests"), toolResult("Vitest check passed: 14 tests")],
    ],
    [
      "build evidence",
      [toolResult("Build completed successfully"), toolResult("Build completed successfully")],
    ],
    [
      "spill reference",
      [
        toolResult("[Large output spilled: 9000 bytes; spill_id=spill-123]"),
        toolResult("[Large output spilled: 9000 bytes; spill_id=spill-123]"),
      ],
    ],
    [
      "multimodal result",
      [
        toolResult("image result", {
          content: [
            { type: "text", text: "image result" },
            { type: "image", data: "fixture" },
          ],
        }),
        toolResult("image result", {
          content: [
            { type: "text", text: "image result" },
            { type: "image", data: "fixture" },
          ],
        }),
      ],
    ],
  ])("preserves the original context for %s", (_case, messages) => {
    const result = pruneDuplicateToolResults(messages);

    expect(result.messages).toBe(messages);
    expect(result.prunedCount).toBe(0);
    expect(result.measuredContextBytesRemoved).toBe(0);
    expect(result.estimatedTokensSaved).toBe(0);
  });

  it("does not enlarge context when the repeated result is shorter than its marker", () => {
    const messages = [toolResult("tiny"), toolResult("tiny")];

    const result = pruneDuplicateToolResults(messages);

    expect(result.messages).toBe(messages);
    expect(result.measuredContextBytesRemoved).toBe(0);
  });

  it("preserves structured details on both the marker and the retained result", () => {
    const details = { source: "read", timestamp: 123 };
    const messages = [
      toolResult("stable read detail".repeat(40), { details, toolCallId: "first" }),
      toolResult("stable read detail".repeat(40), { details, toolCallId: "later" }),
    ];

    const result = pruneDuplicateToolResults(messages);

    expect(result.messages).not.toBe(messages);
    expect(result.messages[0]?.details).toEqual(details);
    expect(result.messages[1]?.details).toEqual(details);
  });
});
