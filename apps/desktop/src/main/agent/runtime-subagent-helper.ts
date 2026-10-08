import type { AgentSessionInfo } from "../../shared/contracts";
import { listAgentEvents } from "./agent-event-store";

export const MAX_SUBAGENTS_PER_SESSION = 6;
export const MAX_WAIT_MEMORY_CANDIDATES = 8;
export const WAIT_MEMORY_CLAIM_CHARS = 320;
export const MAX_WAIT_CODEGRAPH_DISCOVERIES = 50;

export function isSubagentBusy(status: AgentSessionInfo["status"]): boolean {
  return status === "starting" || status === "running" || status === "blocked";
}

export function composeSubagentPrompt(input: {
  prompt: string;
  subagent?: { name: string; body: string };
}): string {
  const body = input.subagent?.body.trim();
  if (!body) {
    return input.prompt;
  }
  return [
    `<subagent_definition name="${input.subagent?.name}">`,
    body,
    "</subagent_definition>",
    "",
    "<task>",
    input.prompt,
    "</task>",
  ].join("\n");
}

export function lastAssistantOutput(sessionId: string): string | undefined {
  const roles = new Map<string, "assistant" | "user">();
  const textByMessage = new Map<string, string>();
  let lastAssistantMessageId: string | undefined;
  for (const { event } of listAgentEvents(sessionId)) {
    if (event.type === "message.started") {
      roles.set(event.messageId, event.role);
      if (event.role === "assistant") {
        textByMessage.set(event.messageId, textByMessage.get(event.messageId) ?? "");
        lastAssistantMessageId = event.messageId;
      }
      continue;
    }
    if (event.type === "message.delta" && roles.get(event.messageId) === "assistant") {
      textByMessage.set(
        event.messageId,
        `${textByMessage.get(event.messageId) ?? ""}${event.delta}`,
      );
      lastAssistantMessageId = event.messageId;
      continue;
    }
    if (event.type === "message.completed" && roles.get(event.messageId) === "assistant") {
      lastAssistantMessageId = event.messageId;
    }
  }
  const output = lastAssistantMessageId ? textByMessage.get(lastAssistantMessageId)?.trim() : "";
  return output || undefined;
}

/**
 * The last assistant text produced by one run: only events after that run's
 * `run.started` count, so a run with no text never reports an earlier turn's.
 */
export function runAssistantOutput(sessionId: string, runId: string): string | undefined {
  const roles = new Map<string, "assistant" | "user">();
  const textByMessage = new Map<string, string>();
  let inRun = false;
  let lastAssistantMessageId: string | undefined;
  for (const { event } of listAgentEvents(sessionId)) {
    if (event.type === "run.started") {
      inRun = event.runId === runId;
      continue;
    }
    if (!inRun) continue;
    if (event.type === "message.started") {
      roles.set(event.messageId, event.role);
      if (event.role === "assistant") {
        textByMessage.set(event.messageId, textByMessage.get(event.messageId) ?? "");
        lastAssistantMessageId = event.messageId;
      }
    } else if (event.type === "message.delta" && roles.get(event.messageId) === "assistant") {
      textByMessage.set(
        event.messageId,
        `${textByMessage.get(event.messageId) ?? ""}${event.delta}`,
      );
      lastAssistantMessageId = event.messageId;
    }
  }
  const output = lastAssistantMessageId ? textByMessage.get(lastAssistantMessageId)?.trim() : "";
  return output || undefined;
}

/** Escapes text placed inside a model-facing XML-ish context tag. */
export function escapeContextText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
