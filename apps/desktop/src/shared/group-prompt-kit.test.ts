import { describe, expect, it } from "vitest";
import {
  buildGroupStepsLabels,
  buildSafeChainOfThought,
  classifyGroupSystemStatus,
  formatAttachmentSize,
} from "./group-prompt-kit";

describe("group-prompt-kit", () => {
  it("classifies rare system statuses vs ops noise", () => {
    expect(classifyGroupSystemStatus("Waiting for you")?.show).toBe("system");
    expect(classifyGroupSystemStatus("Blocked — needs approval")?.variant).toBe("error");
    expect(classifyGroupSystemStatus("Worktree ready: `feat/x`")?.show).toBe("hide");
    expect(classifyGroupSystemStatus("Builder is archived")?.show).toBe("faint");
    expect(classifyGroupSystemStatus("Ready for you")?.show).toBe("hide");
    expect(classifyGroupSystemStatus("Queued…")?.show).toBe("hide");
  });

  it("builds Steps labels from tools", () => {
    expect(
      buildGroupStepsLabels([
        { id: "1", name: "read", label: "Reading", done: true },
        { id: "2", name: "bash", label: "Running", done: false },
      ]),
    ).toEqual(["Reading", "Running…"]);
  });

  it("builds safe CoT without raw thought text", () => {
    const steps = buildSafeChainOfThought({
      phase: "Exploring",
      activity: "searching files",
      tools: [{ id: "1", name: "grep", label: "Searching", done: true }],
      hasStream: true,
    });
    expect(steps[0]).toMatch(/Exploring/i);
    expect(steps.join(" ")).not.toMatch(/secret internal/i);
    expect(steps.some((s) => /Writ/i.test(s))).toBe(true);
  });

  it("formats attachment sizes", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(2048)).toBe("2.0 KB");
    expect(formatAttachmentSize(2_500_000)).toBe("2.4 MB");
  });
});
