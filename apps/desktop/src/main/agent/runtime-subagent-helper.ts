import type { AgentSessionInfo } from "../../shared/contracts";
import {
  listAgentEventRawPage,
  listAgentRunMessagePage,
  MAX_AGENT_EVENT_PAGE_SIZE,
} from "./agent-event-store";

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
  let lastAssistantMessageId: string | undefined;
  let lastAssistantText = "";
  let afterCursor = 0;
  let snapshotCursor: number | undefined;
  while (true) {
    const page = listAgentEventRawPage(sessionId, {
      afterCursor,
      limit: MAX_AGENT_EVENT_PAGE_SIZE,
      ...(snapshotCursor === undefined ? {} : { snapshotCursor }),
    });
    snapshotCursor = page.snapshotCursor;
    for (const { event } of page.events) {
      if (event.type === "message.started" && event.role === "assistant") {
        lastAssistantMessageId = event.messageId;
        lastAssistantText = "";
      } else if (event.type === "message.delta" && event.messageId === lastAssistantMessageId) {
        lastAssistantText += event.delta;
      }
    }
    if (!page.hasMore || page.nextCursor === undefined) break;
    afterCursor = page.nextCursor;
  }
  const output = lastAssistantMessageId ? lastAssistantText.trim() : "";
  return output || undefined;
}

/**
 * Reconstruct one run's final assistant message from bounded, run-scoped pages.
 */
export function runAssistantOutput(sessionId: string, runId: string): string | undefined {
  let lastAssistantMessageId: string | undefined;
  let lastAssistantText = "";
  let afterCursor = 0;
  let snapshotCursor: number | undefined;
  while (true) {
    const page = listAgentRunMessagePage(sessionId, runId, {
      afterCursor,
      limit: MAX_AGENT_EVENT_PAGE_SIZE,
      ...(snapshotCursor === undefined ? {} : { snapshotCursor }),
    });
    snapshotCursor = page.snapshotCursor;
    for (const { event } of page.events) {
      if (event.type === "message.started" && event.role === "assistant") {
        lastAssistantMessageId = event.messageId;
        lastAssistantText = "";
      } else if (event.type === "message.delta" && event.messageId === lastAssistantMessageId) {
        lastAssistantText += event.delta;
      }
    }
    if (!page.hasMore || page.nextCursor === undefined) break;
    afterCursor = page.nextCursor;
  }
  const output = lastAssistantMessageId ? lastAssistantText.trim() : "";
  return output || undefined;
}

/** Escapes text placed inside a model-facing XML-ish context tag. */
export function escapeContextText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
