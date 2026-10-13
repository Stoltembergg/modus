import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../../shared/contracts";
import { shellText } from "../../../../shared/shell-text";
import { currentRunStage, type RunStage, runStageText } from "./runStage";

const S = "s";
const wrap = (events: AgentEvent[]) => events.map((event) => ({ event }));
const runStarted: AgentEvent = {
  type: "run.started",
  sessionId: S,
  runId: "r",
  delivery: "normal",
};
const think: AgentEvent = { type: "thinking.delta", sessionId: S, messageId: "m", delta: "hmm" };
const start = (id: string, toolName: string, args?: unknown): AgentEvent => ({
  type: "tool.started",
  sessionId: S,
  toolCallId: id,
  toolName,
  args,
});
const end = (id: string): AgentEvent => ({
  type: "tool.ended",
  sessionId: S,
  toolCallId: id,
  isError: false,
});
const stage = (events: AgentEvent[]) => currentRunStage(wrap(events));
const label = (s: RunStage, locale?: string) => {
  const { key, vars } = runStageText(s);
  return shellText(key, locale, vars);
};

describe("currentRunStage", () => {
  it("falls back to working before any stage event", () => {
    expect(stage([])).toEqual({ kind: "working" });
    expect(stage([runStarted])).toEqual({ kind: "working" });
  });

  it("maps thinking, writing and subagents", () => {
    expect(stage([runStarted, think])).toEqual({ kind: "thinking" });
    expect(
      stage([runStarted, { type: "message.delta", sessionId: S, messageId: "m", delta: "Hi" }]),
    ).toEqual({ kind: "writing" });
    expect(stage([runStarted, start("t", "task", { prompt: "x" })])).toEqual({
      kind: "spawningSubagent",
    });
    expect(
      stage([
        runStarted,
        {
          type: "subagent.started",
          sessionId: S,
          childSessionId: "c",
          task: "x",
          subagentType: "general",
        },
      ]),
    ).toEqual({ kind: "spawningSubagent" });
  });

  it("maps tools with their command or file", () => {
    expect(stage([runStarted, start("t", "bash", { command: "npm test" })])).toEqual({
      kind: "runningCommand",
      command: "npm test",
    });
    expect(stage([runStarted, start("t", "edit", { path: "src/app/App.tsx" })])).toEqual({
      kind: "editing",
      file: "App.tsx",
    });
    expect(stage([runStarted, start("t", "read", { path: "/r/README.md" })])).toEqual({
      kind: "reading",
      file: "README.md",
    });
    expect(stage([runStarted, start("t", "grep", { pattern: "x" })])).toEqual({
      kind: "searching",
    });
    expect(stage([runStarted, start("t", "mcp_github_search")])).toEqual({
      kind: "runningTool",
      tool: "mcp_github_search",
    });
  });

  it("uses the host MCP identity instead of an encoded tool name", () => {
    const event = {
      ...start("mcp", "mcp_v1_dangerous_h_opaque"),
      mcp: { server: "GitHub", tool: "search_code" },
    } as AgentEvent;
    const live = stage([runStarted, event]);
    expect(label(live)).toBe("Using GitHub · search_code");
    expect(label(live, "pt")).toBe("Usando GitHub · search_code");
  });

  it("goes back to thinking once the tool ends, unless a parallel tool still runs", () => {
    expect(stage([runStarted, start("a", "bash", { command: "ls" }), end("a")])).toEqual({
      kind: "thinking",
    });
    expect(
      stage([
        runStarted,
        start("a", "read", { path: "a.ts" }),
        start("b", "bash", { command: "ls" }),
        end("b"),
      ]),
    ).toEqual({ kind: "reading", file: "a.ts" });
  });

  it("ignores stages from a previous run", () => {
    expect(stage([start("old", "bash", { command: "old" }), runStarted])).toEqual({
      kind: "working",
    });
  });

  it("clips long commands to one line", () => {
    const s = stage([runStarted, start("t", "bash", { command: `echo ${"x".repeat(200)}\nls` })]);
    expect(s.kind).toBe("runningCommand");
    const command = (s as { command: string }).command;
    expect(command.length).toBeLessThanOrEqual(80);
    expect(command).not.toContain("\n");
    expect(command.endsWith("…")).toBe(true);
  });
});

describe("runStageText", () => {
  it("renders localized labels in en/pt/zh", () => {
    expect(label({ kind: "working" })).toBe("Working on your request");
    expect(label({ kind: "thinking" })).toBe("Thinking…");
    expect(label({ kind: "runningCommand", command: "npm test" })).toBe("Running npm test");
    expect(label({ kind: "editing", file: "App.tsx" }, "pt")).toBe("Editando App.tsx");
    expect(label({ kind: "spawningSubagent" }, "pt")).toBe("Iniciando subagente");
    expect(label({ kind: "thinking" }, "zh")).toBe("思考中…");
  });
});
