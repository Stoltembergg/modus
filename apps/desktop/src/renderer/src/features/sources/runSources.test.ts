import { describe, expect, it } from "vitest";
import type { AgentEventItem } from "../agent/agentEventHub";
import { collectRunSources } from "./runSources";

function entry(id: string, event: AgentEventItem["event"]): AgentEventItem {
  return { id, event };
}

describe("collectRunSources", () => {
  it("collects only successful sources from the requested run", () => {
    const items = [
      entry("run-a", { type: "run.started", sessionId: "s", runId: "run-a", delivery: "normal" }),
      entry("read-a", {
        type: "tool.started",
        sessionId: "s",
        runId: "run-a",
        toolCallId: "read-a",
        toolName: "read_file",
        args: { path: "src/features/chat.tsx" },
      }),
      entry("read-end", {
        type: "tool.ended",
        sessionId: "s",
        runId: "run-a",
        toolCallId: "read-a",
        isError: false,
      }),
      entry("web", {
        type: "tool.started",
        sessionId: "s",
        toolCallId: "web",
        toolName: "web_search",
        args: { query: "React docs" },
      }),
      entry("web-output", {
        type: "tool.output",
        sessionId: "s",
        toolCallId: "web",
        output: "See https://react.dev/reference/react and https://localhost:4000/private",
      }),
      entry("web-end", {
        type: "tool.ended",
        sessionId: "s",
        runId: "run-a",
        toolCallId: "web",
        isError: false,
      }),
      entry("failed", {
        type: "tool.started",
        sessionId: "s",
        runId: "run-a",
        toolCallId: "failed",
        toolName: "github_search",
        args: { query: "modus" },
      }),
      entry("failed-end", {
        type: "tool.ended",
        sessionId: "s",
        runId: "run-a",
        toolCallId: "failed",
        isError: true,
      }),
      entry("run-b", { type: "run.started", sessionId: "s", runId: "run-b", delivery: "normal" }),
      entry("github", {
        type: "tool.started",
        sessionId: "s",
        runId: "run-b",
        toolCallId: "github",
        toolName: "github_search",
        args: { query: "modus" },
      }),
      entry("github-end", {
        type: "tool.ended",
        sessionId: "s",
        runId: "run-b",
        toolCallId: "github",
        isError: false,
      }),
    ];

    const sources = collectRunSources(items, "run-a");
    expect(sources).toEqual([
      expect.objectContaining({ kind: "file", label: "chat.tsx", path: "src/features/chat.tsx" }),
      expect.objectContaining({
        kind: "documentation",
        href: "https://react.dev/reference/react",
      }),
    ]);
  });

  it("shows successful connected sources without adding tool output text", () => {
    const sources = collectRunSources(
      [
        entry("run", { type: "run.started", sessionId: "s", runId: "r", delivery: "normal" }),
        entry("start", {
          type: "tool.started",
          sessionId: "s",
          runId: "r",
          toolCallId: "t",
          toolName: "composio_slack_search_messages",
        }),
        entry("output", {
          type: "tool.output",
          sessionId: "s",
          toolCallId: "t",
          output: "Found 4 private messages with internal details",
        }),
        entry("end", {
          type: "tool.ended",
          sessionId: "s",
          runId: "r",
          toolCallId: "t",
          isError: false,
        }),
      ],
      "r",
    );

    expect(sources).toEqual([
      expect.objectContaining({
        kind: "connection",
        label: "Composio",
        detail: "slack search messages",
      }),
    ]);
    expect(JSON.stringify(sources)).not.toContain("private messages");
  });
});
