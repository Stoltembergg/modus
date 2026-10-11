import { MAX_RUN_TOOL_EVIDENCE_PAGE_BYTES } from "../../../../shared/agent-events";
import type { AgentEventItem } from "../agent/agentEventHub";

export type RunSourceKind = "file" | "url" | "documentation" | "github" | "connection";

export type RunSource = {
  id: string;
  kind: RunSourceKind;
  label: string;
  href?: string;
  path?: string;
  detail?: string;
};

/** State of complete, run-scoped source history loaded for visible chat runs. */
export type RunSourcesSnapshot = {
  requestedRunIds: ReadonlySet<string>;
  loadingRunIds: ReadonlySet<string>;
  failedRunIds: ReadonlySet<string>;
  sourcesByRun: ReadonlyMap<string, RunSource[]>;
};

type ToolCall = {
  runId?: string;
  toolName: string;
  paths: string[];
  urls: string[];
  output: string;
  tracksOutput: boolean;
  completedSuccessfully: boolean;
  retainedMetadataBytes: number;
  retainedReferenceBytes: number;
  retainedOutputBytes: number;
};

export class RunSourceCollectionError extends Error {}

class RunSourceCollectionLimitError extends RunSourceCollectionError {
  constructor() {
    super("Run source collection limit exceeded; the complete source set is unavailable.");
    this.name = "RunSourceCollectionLimitError";
  }
}

class RunSourceAttributionError extends RunSourceCollectionError {
  constructor() {
    super("Run source attribution is ambiguous; the complete source set is unavailable.");
    this.name = "RunSourceAttributionError";
  }
}

export type RunSourceLookupSnapshot = {
  sources: RunSource[];
  status: "loading" | "loaded" | "unavailable";
};

const MAX_ACTIVE_TOOL_CALLS = 256;
const MAX_ARGUMENT_SCAN_BYTES_PER_CALL = 256 * 1024;
const MAX_ARGUMENT_SCAN_NODES_PER_CALL = 16_384;
const MAX_ARGUMENT_SCAN_DEPTH = 64;
const MAX_TOTAL_SOURCE_SCAN_BYTES = MAX_RUN_TOOL_EVIDENCE_PAGE_BYTES;
const MAX_ACTIVE_ARGUMENT_REFERENCE_BYTES = 256 * 1024;
const MAX_ACTIVE_CALL_METADATA_BYTES = 256 * 1024;
const MAX_TOOL_IDENTITY_BYTES = 4096;
const MAX_ACTIVE_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_RETAINED_SOURCE_BYTES = 256 * 1024;
const MAX_URL_MATCHES_PER_TEXT = 64;
const MAX_ARGUMENT_REFERENCES_PER_CALL = 64;

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

function utf8ByteLength(value: string, maximum = Number.POSITIVE_INFINITY): number | undefined {
  if (value.length > maximum) return undefined;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maximum) return undefined;
  }
  return bytes;
}

function cleanUrl(raw: string): string | undefined {
  const cleaned = raw.replace(/[),.;!?\]}]+$/u, "");
  try {
    const url = new URL(cleaned);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || LOCAL_HOSTS.has(url.hostname)) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function getUrls(value: string): string[] {
  const found: string[] = [];
  let matches = 0;
  for (const [raw] of value.matchAll(URL_PATTERN)) {
    matches++;
    if (matches > MAX_URL_MATCHES_PER_TEXT) throw new RunSourceCollectionLimitError();
    const url = cleanUrl(raw ?? "");
    if (url) found.push(url);
  }
  return found;
}

function integrationName(toolName: string): string | undefined {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("github")) return "GitHub";
  if (normalized.includes("composio")) return "Composio";
  const known = [
    "dropbox",
    "drive",
    "gmail",
    "google",
    "linear",
    "notion",
    "outlook",
    "slack",
    "teams",
  ];
  const found = known.find((name) => normalized.includes(name));
  if (found) return found[0]?.toUpperCase() + found.slice(1);
  if (normalized.startsWith("mcp__")) {
    const provider = toolName.split("__")[1]?.replace(/[-_]/gu, " ").trim();
    return provider ? provider.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()) : "MCP";
  }
  return undefined;
}

function isExternalSourceTool(toolName: string): boolean {
  return /web|search|browser|fetch|http|github|composio|mcp__|notion|linear|slack|drive|dropbox|gmail|outlook|teams|documentation|docs/iu.test(
    toolName,
  );
}

function isFileReadTool(toolName: string): boolean {
  return /(?:^|[._:/-])(read|open|load|cat|grep|glob|list|view|search)(?:$|[._:/-])/iu.test(
    toolName,
  );
}

function collectArgumentReferences(
  args: unknown,
  trackPaths: boolean,
  trackUrls: boolean,
): { paths: string[]; urls: string[]; scannedBytes: number; referenceBytes: number } {
  const paths: string[] = [];
  const urls: string[] = [];
  const ancestors = new WeakSet<object>();
  let scannedBytes = 0;
  let visitedNodes = 0;
  let referenceBytes = 0;

  const addScanBytes = (bytes: number): void => {
    scannedBytes += bytes;
    if (scannedBytes > MAX_ARGUMENT_SCAN_BYTES_PER_CALL) {
      throw new RunSourceCollectionLimitError();
    }
  };
  const addReference = (value: string, target: string[]): void => {
    const bytes = utf8ByteLength(value, MAX_ACTIVE_ARGUMENT_REFERENCE_BYTES);
    if (bytes === undefined || target.length >= MAX_ARGUMENT_REFERENCES_PER_CALL) {
      throw new RunSourceCollectionLimitError();
    }
    referenceBytes += bytes;
    if (referenceBytes > MAX_ACTIVE_ARGUMENT_REFERENCE_BYTES) {
      throw new RunSourceCollectionLimitError();
    }
    target.push(value);
  };

  const visit = (value: unknown, key: string, depth: number): void => {
    visitedNodes++;
    if (visitedNodes > MAX_ARGUMENT_SCAN_NODES_PER_CALL || depth > MAX_ARGUMENT_SCAN_DEPTH) {
      throw new RunSourceCollectionLimitError();
    }
    addScanBytes(8);

    if (typeof value === "string") {
      const bytes = utf8ByteLength(value, MAX_ARGUMENT_SCAN_BYTES_PER_CALL - scannedBytes);
      if (bytes === undefined) throw new RunSourceCollectionLimitError();
      addScanBytes(bytes);
      if (trackPaths && /^(?:path|file|filepath|file_path|absolute_path|target)$/iu.test(key)) {
        const path = value.trim();
        if (path && !/^(?:https?:|file:)/iu.test(path)) addReference(path, paths);
      }
      if (trackUrls) {
        for (const url of getUrls(value)) addReference(url, urls);
      }
      return;
    }

    if (value === null || typeof value === "boolean" || typeof value === "number") {
      addScanBytes(8);
      return;
    }

    if (Array.isArray(value)) {
      if (ancestors.has(value) || value.length > MAX_ARGUMENT_SCAN_NODES_PER_CALL - visitedNodes) {
        throw new RunSourceCollectionLimitError();
      }
      ancestors.add(value);
      for (let index = 0; index < value.length; index++) visit(value[index], key, depth + 1);
      ancestors.delete(value);
      return;
    }

    if (typeof value === "object") {
      const prototype = Object.getPrototypeOf(value);
      if ((prototype !== Object.prototype && prototype !== null) || ancestors.has(value)) {
        throw new RunSourceCollectionLimitError();
      }
      ancestors.add(value);
      for (const childKey in value) {
        if (!Object.hasOwn(value, childKey)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, childKey);
        if (!descriptor?.enumerable) continue;
        if (!("value" in descriptor)) throw new RunSourceCollectionLimitError();
        const keyBytes = utf8ByteLength(childKey, MAX_ARGUMENT_SCAN_BYTES_PER_CALL - scannedBytes);
        if (keyBytes === undefined) throw new RunSourceCollectionLimitError();
        addScanBytes(keyBytes);
        visit(descriptor.value, childKey, depth + 1);
      }
      ancestors.delete(value);
      return;
    }

    throw new RunSourceCollectionLimitError();
  };

  visit(args, "", 0);
  return { paths, urls, scannedBytes, referenceBytes };
}

function sourceKindForUrl(href: string): RunSourceKind {
  const hostname = new URL(href).hostname.toLowerCase();
  if (hostname === "github.com" || hostname.endsWith(".github.com")) return "github";
  if (
    hostname.startsWith("docs.") ||
    hostname.startsWith("developer.") ||
    hostname.startsWith("developers.") ||
    hostname === "react.dev" ||
    hostname === "nodejs.org" ||
    hostname === "docs.rs" ||
    hostname.includes("readthedocs") ||
    hostname.includes("documentation")
  ) {
    return "documentation";
  }
  return "url";
}

function basename(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/$/u, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function sourceKey(source: RunSource): string {
  return source.href
    ? `${source.kind}:${source.href}`
    : source.path
      ? `file:${source.path}`
      : `${source.kind}:${source.label}:${source.detail ?? ""}`;
}

/**
 * Collect references from completed, successful tool calls belonging to one
 * run. Raw tool outputs stay in the event log and are never copied into chat.
 */
export function collectRunSources(
  items: readonly AgentEventItem[],
  targetRunId: string,
): RunSource[] {
  const collector = createRunSourceCollector(targetRunId);
  collector.append(items);
  return collector.finish();
}

/** Incremental source extraction for bounded event-page consumers. */
export function createRunSourceCollector(targetRunId: string): {
  append(items: readonly AgentEventItem[]): void;
  finish(): RunSource[];
} {
  if (utf8ByteLength(targetRunId, MAX_TOOL_IDENTITY_BYTES) === undefined) {
    throw new RunSourceCollectionLimitError();
  }
  const calls = new Map<string, ToolCall>();
  const activeCallRunIds = new Map<string, string | undefined>();
  const sources = new Map<string, RunSource>();
  let activeRunId: string | undefined;
  let failure: RunSourceCollectionError | undefined;
  let scannedBytes = 0;
  let activeMetadataBytes = 0;
  let activeReferenceBytes = 0;
  let activeOutputBytes = 0;
  let retainedSourceBytes = 0;

  const assertRunScanBudget = (bytes: number): void => {
    scannedBytes += bytes;
    if (scannedBytes > MAX_TOTAL_SOURCE_SCAN_BYTES) {
      throw new RunSourceCollectionLimitError();
    }
  };

  const releaseCall = (toolCallId: string): void => {
    const call = calls.get(toolCallId);
    if (call) {
      activeMetadataBytes -= call.retainedMetadataBytes;
      activeReferenceBytes -= call.retainedReferenceBytes;
      activeOutputBytes -= call.retainedOutputBytes;
    }
    calls.delete(toolCallId);
    activeCallRunIds.delete(toolCallId);
  };

  const add = (source: RunSource): void => {
    let sourceBytes = 0;
    for (const value of [
      source.kind,
      source.label,
      source.href ?? "",
      source.path ?? "",
      source.detail ?? "",
    ]) {
      const bytes = utf8ByteLength(value, MAX_RETAINED_SOURCE_BYTES - sourceBytes);
      if (bytes === undefined) throw new RunSourceCollectionLimitError();
      sourceBytes += bytes;
    }
    const key = sourceKey(source);
    if (sources.has(key) || sources.size >= 24) return;
    const keyBytes = utf8ByteLength(key, MAX_RETAINED_SOURCE_BYTES - sourceBytes);
    if (keyBytes === undefined) throw new RunSourceCollectionLimitError();
    const retainedBytes = sourceBytes + keyBytes + 32;
    if (retainedSourceBytes + retainedBytes > MAX_RETAINED_SOURCE_BYTES) {
      throw new RunSourceCollectionLimitError();
    }
    sources.set(key, { ...source, id: key });
    retainedSourceBytes += retainedBytes;
  };

  const addCompletedCallSources = (call: ToolCall): void => {
    if (call.runId !== targetRunId || !call.completedSuccessfully) return;
    const integration = integrationName(call.toolName);
    if (integration) {
      const action = call.toolName
        .replace(/^mcp__[^_]+__/iu, "")
        .replace(/^(?:composio[_:.-]?)/iu, "")
        .replace(/[._-]+/gu, " ")
        .trim();
      add({
        id: "",
        kind: integration === "GitHub" ? "github" : "connection",
        label: integration,
        ...(action ? { detail: action } : {}),
      });
    }

    if (isFileReadTool(call.toolName)) {
      for (const path of call.paths) {
        add({ id: "", kind: "file", label: basename(path), path });
      }
    }

    if (isExternalSourceTool(call.toolName)) {
      const urls = [...getUrls(call.output), ...call.urls];
      for (const href of urls) {
        add({ id: "", kind: sourceKindForUrl(href), label: new URL(href).hostname, href });
      }
    }
  };

  const append = (items: readonly AgentEventItem[]): void => {
    if (failure) throw failure;
    try {
      for (const { event } of items) {
        if (event.type === "run.started") {
          if (utf8ByteLength(event.runId, MAX_TOOL_IDENTITY_BYTES) === undefined) {
            throw new RunSourceCollectionLimitError();
          }
          activeRunId = event.runId;
          continue;
        }
        if (
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.blocked" ||
          event.type === "run.cancelled"
        ) {
          if (activeRunId === event.runId) activeRunId = undefined;
          for (const [toolCallId, runId] of activeCallRunIds) {
            if (runId === event.runId) releaseCall(toolCallId);
          }
          continue;
        }
        if (event.type === "tool.started") {
          const runId = event.runId ?? activeRunId;
          const toolCallIdBytes = utf8ByteLength(event.toolCallId, MAX_TOOL_IDENTITY_BYTES);
          const runIdBytes = runId ? utf8ByteLength(runId, MAX_TOOL_IDENTITY_BYTES) : 0;
          if (toolCallIdBytes === undefined || runIdBytes === undefined) {
            throw new RunSourceCollectionLimitError();
          }
          if (activeCallRunIds.has(event.toolCallId)) throw new RunSourceAttributionError();
          if (activeCallRunIds.size >= MAX_ACTIVE_TOOL_CALLS) {
            throw new RunSourceCollectionLimitError();
          }
          activeCallRunIds.set(event.toolCallId, runId);
          if (runId !== targetRunId) continue;

          const toolNameBytes = utf8ByteLength(event.toolName, MAX_TOOL_IDENTITY_BYTES);
          if (toolNameBytes === undefined) throw new RunSourceCollectionLimitError();
          const retainedMetadataBytes = toolCallIdBytes + toolNameBytes + runIdBytes;
          if (activeMetadataBytes + retainedMetadataBytes > MAX_ACTIVE_CALL_METADATA_BYTES) {
            throw new RunSourceCollectionLimitError();
          }

          const tracksPaths = isFileReadTool(event.toolName);
          const tracksUrls = isExternalSourceTool(event.toolName);
          const references =
            (tracksPaths || tracksUrls) && event.args !== undefined
              ? collectArgumentReferences(event.args, tracksPaths, tracksUrls)
              : { paths: [], urls: [], scannedBytes: 0, referenceBytes: 0 };
          assertRunScanBudget(references.scannedBytes);
          if (
            activeReferenceBytes + references.referenceBytes >
            MAX_ACTIVE_ARGUMENT_REFERENCE_BYTES
          ) {
            throw new RunSourceCollectionLimitError();
          }
          activeMetadataBytes += retainedMetadataBytes;
          activeReferenceBytes += references.referenceBytes;
          calls.set(event.toolCallId, {
            ...(runId ? { runId } : {}),
            toolName: event.toolName,
            paths: references.paths,
            urls: references.urls,
            output: "",
            tracksOutput: tracksUrls,
            completedSuccessfully: false,
            retainedMetadataBytes,
            retainedReferenceBytes: references.referenceBytes,
            retainedOutputBytes: 0,
          });
          continue;
        }
        if (event.type === "tool.output") {
          if (utf8ByteLength(event.toolCallId, MAX_TOOL_IDENTITY_BYTES) === undefined) {
            throw new RunSourceCollectionLimitError();
          }
          if (activeCallRunIds.get(event.toolCallId) !== targetRunId) continue;
          const call = calls.get(event.toolCallId);
          if (!call?.tracksOutput) continue;
          const bytes = utf8ByteLength(
            event.output,
            MAX_ACTIVE_TOOL_OUTPUT_BYTES - activeOutputBytes,
          );
          if (bytes === undefined) throw new RunSourceCollectionLimitError();
          assertRunScanBudget(bytes);
          activeOutputBytes += bytes;
          call.retainedOutputBytes += bytes;
          call.output += event.output;
          continue;
        }
        if (event.type === "tool.ended") {
          if (utf8ByteLength(event.toolCallId, MAX_TOOL_IDENTITY_BYTES) === undefined) {
            throw new RunSourceCollectionLimitError();
          }
          if (!activeCallRunIds.has(event.toolCallId)) continue;
          const startedRunId = activeCallRunIds.get(event.toolCallId);
          if (event.runId !== undefined && event.runId !== startedRunId) {
            throw new RunSourceAttributionError();
          }
          if (startedRunId !== targetRunId) {
            activeCallRunIds.delete(event.toolCallId);
            continue;
          }
          const call = calls.get(event.toolCallId);
          if (!call) {
            activeCallRunIds.delete(event.toolCallId);
            continue;
          }
          const runId = startedRunId;
          const nextToolName = event.toolName ?? call.toolName;
          const previousToolNameBytes = utf8ByteLength(call.toolName, MAX_TOOL_IDENTITY_BYTES);
          const nextToolNameBytes = utf8ByteLength(nextToolName, MAX_TOOL_IDENTITY_BYTES);
          const previousRunIdBytes = call.runId
            ? utf8ByteLength(call.runId, MAX_TOOL_IDENTITY_BYTES)
            : 0;
          const nextRunIdBytes = runId ? utf8ByteLength(runId, MAX_TOOL_IDENTITY_BYTES) : 0;
          if (
            previousToolNameBytes === undefined ||
            nextToolNameBytes === undefined ||
            previousRunIdBytes === undefined ||
            nextRunIdBytes === undefined
          ) {
            throw new RunSourceCollectionLimitError();
          }
          const metadataDelta =
            nextToolNameBytes - previousToolNameBytes + nextRunIdBytes - previousRunIdBytes;
          if (activeMetadataBytes + metadataDelta > MAX_ACTIVE_CALL_METADATA_BYTES) {
            throw new RunSourceCollectionLimitError();
          }
          activeMetadataBytes += metadataDelta;
          call.retainedMetadataBytes += metadataDelta;
          if (runId) call.runId = runId;
          call.toolName = nextToolName;
          call.completedSuccessfully = !event.isError && !event.aborted && !event.skipped;
          try {
            addCompletedCallSources(call);
          } finally {
            releaseCall(event.toolCallId);
          }
        }
      }
    } catch (error) {
      if (error instanceof RunSourceCollectionError) failure = error;
      throw error;
    }
  };

  const finish = (): RunSource[] => {
    if (failure) throw failure;
    return [...sources.values()];
  };

  return { append, finish };
}
