import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { canonicalizeExternalReferenceUrl } from "../../memory/external-reference-url";

export type McpCitation = {
  id: string;
  sessionId: string;
  runId: string;
  serverName: string;
  toolName: string;
  url: string;
  title?: string;
  retrievedAt: string;
};

const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 256;
const MAX_SERVER_NAME_LENGTH = 128;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_CITATIONS_PER_RESULT = 10;
const MAX_CITATIONS_PER_RUN = 20;
const MAX_ACTIVE_RUNS = 1000;
type RunCitations = {
  sessionId: string;
  runId: string;
  citationsById: Map<string, McpCitation>;
  citationsByUrl: Map<string, McpCitation>;
};

const citationsByRun = new Map<string, RunCitations>();

function runKey(sessionId: string, runId: string): string {
  return JSON.stringify([sessionId, runId]);
}

function boundedDisplayText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value.slice(0, maxLength * 2))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })
    .join("")
    .trim()
    .slice(0, maxLength);
  return cleaned || undefined;
}

function canonicalHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_URL_LENGTH) return undefined;
  return canonicalizeExternalReferenceUrl(value.trim(), MAX_URL_LENGTH);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function candidateFromContent(content: unknown): { url: string; title?: string } | undefined {
  const block = asRecord(content);
  if (!block) return undefined;

  let uri: unknown;
  let title: string | undefined;
  if (block.type === "resource_link") {
    uri = block.uri;
    title =
      boundedDisplayText(block.title, MAX_TITLE_LENGTH) ??
      boundedDisplayText(block.name, MAX_TITLE_LENGTH);
  } else if (block.type === "resource") {
    const resource = asRecord(block.resource);
    if (!resource) return undefined;
    uri = resource.uri;
    title =
      boundedDisplayText(resource.title, MAX_TITLE_LENGTH) ??
      boundedDisplayText(resource.name, MAX_TITLE_LENGTH) ??
      boundedDisplayText(block.title, MAX_TITLE_LENGTH) ??
      boundedDisplayText(block.name, MAX_TITLE_LENGTH);
  } else {
    return undefined;
  }

  const url = canonicalHttpUrl(uri);
  if (!url) return undefined;
  return { url, ...(title ? { title } : {}) };
}

function getOrCreateRun(sessionId: string, runId: string): RunCitations {
  const key = runKey(sessionId, runId);
  const existing = citationsByRun.get(key);
  if (existing) return existing;

  if (citationsByRun.size >= MAX_ACTIVE_RUNS) {
    const oldestKey = citationsByRun.keys().next().value as string | undefined;
    if (oldestKey !== undefined) citationsByRun.delete(oldestKey);
  }
  const run: RunCitations = {
    sessionId,
    runId,
    citationsById: new Map(),
    citationsByUrl: new Map(),
  };
  citationsByRun.set(key, run);
  return run;
}

function cloneCitation(citation: McpCitation): McpCitation {
  return { ...citation };
}

/** Register metadata-only references from explicit MCP resource content in a successful result. */
export function registerMcpCitations(
  sessionId: string,
  runId: string,
  serverName: string,
  toolName: string,
  result: CallToolResult,
): McpCitation[] {
  if (!result || result.isError === true || !Array.isArray(result.content)) return [];
  const safeServerName = boundedDisplayText(serverName, MAX_SERVER_NAME_LENGTH);
  const safeToolName = boundedDisplayText(toolName, MAX_TOOL_NAME_LENGTH);
  if (!sessionId || !runId || !safeServerName || !safeToolName) return [];

  const run = getOrCreateRun(sessionId, runId);
  const registered: McpCitation[] = [];
  const returnedIds = new Set<string>();
  for (const content of result.content) {
    if (registered.length >= MAX_CITATIONS_PER_RESULT) break;
    const candidate = candidateFromContent(content);
    if (!candidate) continue;

    const duplicate = run.citationsByUrl.get(candidate.url);
    if (duplicate) {
      if (!returnedIds.has(duplicate.id)) {
        registered.push(cloneCitation(duplicate));
        returnedIds.add(duplicate.id);
      }
      continue;
    }
    if (run.citationsById.size >= MAX_CITATIONS_PER_RUN) continue;

    const citation: McpCitation = {
      id: randomUUID(),
      sessionId,
      runId,
      serverName: safeServerName,
      toolName: safeToolName,
      url: candidate.url,
      ...(candidate.title ? { title: candidate.title } : {}),
      retrievedAt: new Date().toISOString(),
    };
    run.citationsById.set(citation.id, citation);
    run.citationsByUrl.set(citation.url, citation);
    registered.push(cloneCitation(citation));
    returnedIds.add(citation.id);
  }
  return registered;
}

/** Resolve only a registry-issued ID owned by this exact session and run. */
export function resolveMcpCitation(
  sessionId: string,
  runId: string,
  citationId: string,
): McpCitation | undefined {
  const citation = citationsByRun.get(runKey(sessionId, runId))?.citationsById.get(citationId);
  return citation ? cloneCitation(citation) : undefined;
}

/** Expire every citation for a run. Repeated clears are harmless. */
export function clearRun(sessionId: string, runId: string): void {
  citationsByRun.delete(runKey(sessionId, runId));
}
