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

type ToolCall = {
  runId?: string;
  toolName: string;
  args?: unknown;
  output: string;
  completedSuccessfully: boolean;
};

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

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
  return Array.from(value.matchAll(URL_PATTERN), ([raw]) => cleanUrl(raw ?? "")).filter(
    (url): url is string => Boolean(url),
  );
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

function argsPaths(args: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, key = ""): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [childKey, child] of Object.entries(value)) {
      if (/^(?:path|file|filepath|file_path|absolute_path|target)$/iu.test(childKey)) {
        if (typeof child === "string") {
          const path = child.trim();
          if (path && !/^(?:https?:|file:)/iu.test(path)) found.push(path);
        } else {
          visit(child, childKey);
        }
      } else {
        visit(child, childKey || key);
      }
    }
  };
  visit(args);
  return found;
}

function argsUrls(args: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "string") {
      found.push(...getUrls(value));
      return;
    }
    if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(visit);
    }
  };
  visit(args);
  return found;
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
  const calls = new Map<string, ToolCall>();
  const completed: ToolCall[] = [];
  let activeRunId: string | undefined;

  for (const { event } of items) {
    if (event.type === "run.started") {
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
      continue;
    }
    if (event.type === "tool.started") {
      const runId = event.runId ?? activeRunId;
      calls.set(event.toolCallId, {
        ...(runId ? { runId } : {}),
        toolName: event.toolName,
        ...(event.args !== undefined ? { args: event.args } : {}),
        output: "",
        completedSuccessfully: false,
      });
      continue;
    }
    if (event.type === "tool.output") {
      const call = calls.get(event.toolCallId);
      if (call) call.output += event.output;
      continue;
    }
    if (event.type === "tool.ended") {
      const call = calls.get(event.toolCallId);
      if (!call) continue;
      const runId = event.runId ?? call.runId ?? activeRunId;
      if (runId) call.runId = runId;
      call.toolName = event.toolName ?? call.toolName;
      call.completedSuccessfully = !event.isError && !event.aborted && !event.skipped;
      completed.push(call);
    }
  }

  const sources = new Map<string, RunSource>();
  const add = (source: RunSource): void => {
    const key = sourceKey(source);
    if (!sources.has(key)) sources.set(key, { ...source, id: key });
  };

  for (const call of completed) {
    if (call.runId !== targetRunId || !call.completedSuccessfully) continue;
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
      for (const path of argsPaths(call.args)) {
        add({ id: "", kind: "file", label: basename(path), path });
      }
    }

    if (isExternalSourceTool(call.toolName)) {
      const urls = [...getUrls(call.output), ...argsUrls(call.args)];
      for (const href of urls) {
        add({ id: "", kind: sourceKindForUrl(href), label: new URL(href).hostname, href });
      }
    }
  }

  return [...sources.values()].slice(0, 24);
}
