import type { AgentEvent } from "../../../../shared/contracts";
import type { ShellTextKey, ShellTextVars } from "../../../../shared/shell-text";

/**
 * The live stage of the current run, derived from the same agent events the
 * Activity panel renders. Read newest-first back to the latest `run.started`;
 * no stage-bearing event yet means the generic "Working on your request".
 */
export type RunStage =
  | { kind: "working" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "runningCommand"; command: string }
  | { kind: "runningTool"; tool: string }
  | { kind: "editing"; file: string }
  | { kind: "reading"; file: string }
  | { kind: "searching" }
  | { kind: "spawningSubagent" };

const MAX_DETAIL = 80;

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL ? `${oneLine.slice(0, MAX_DETAIL - 1)}…` : oneLine;
}

function stringArg(args: unknown, ...keys: string[]): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function toolStage(toolName: string, args: unknown): RunStage {
  switch (toolName) {
    case "bash": {
      const command = stringArg(args, "command", "cmd");
      return command
        ? { kind: "runningCommand", command: clip(command) }
        : { kind: "runningTool", tool: "bash" };
    }
    case "edit":
    case "write": {
      const path = stringArg(args, "path", "file_path", "filePath");
      return path
        ? { kind: "editing", file: clip(baseName(path)) }
        : { kind: "runningTool", tool: toolName };
    }
    case "read": {
      const path = stringArg(args, "path", "file_path", "filePath");
      return path
        ? { kind: "reading", file: clip(baseName(path)) }
        : { kind: "runningTool", tool: toolName };
    }
    case "grep":
    case "find":
    case "ls":
      return { kind: "searching" };
    case "task":
      return { kind: "spawningSubagent" };
    default:
      return { kind: "runningTool", tool: clip(toolName) };
  }
}

export function currentRunStage(events: ReadonlyArray<{ event: AgentEvent }>): RunStage {
  const ended = new Set<string>();
  // A finished tool with nothing newer: the model is deciding its next step,
  // unless a parallel tool call is still running (found further back).
  let afterTool = false;
  const settle = (fallback: RunStage): RunStage => (afterTool ? { kind: "thinking" } : fallback);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (!event) continue;
    switch (event.type) {
      case "run.started":
        return settle({ kind: "working" });
      case "tool.ended":
        ended.add(event.toolCallId);
        afterTool = true;
        break;
      case "tool.started":
      case "tool.delta":
        if (!ended.has(event.toolCallId)) return toolStage(event.toolName, event.args);
        break;
      case "subagent.started":
        return settle({ kind: "spawningSubagent" });
      case "thinking.delta":
      case "thinking.completed":
        return { kind: "thinking" };
      case "message.delta":
        return settle({ kind: "writing" });
      case "message.started":
        if (event.role === "user") return settle({ kind: "working" });
        break;
      default:
        break;
    }
  }
  return settle({ kind: "working" });
}

export function runStageText(stage: RunStage): { key: ShellTextKey; vars?: ShellTextVars } {
  switch (stage.kind) {
    case "runningCommand":
      return { key: "shell.run.runningCommand", vars: { command: stage.command } };
    case "runningTool":
      return { key: "shell.run.runningTool", vars: { tool: stage.tool } };
    case "editing":
      return { key: "shell.run.editing", vars: { file: stage.file } };
    case "reading":
      return { key: "shell.run.reading", vars: { file: stage.file } };
    default:
      return { key: `shell.run.${stage.kind}` };
  }
}
