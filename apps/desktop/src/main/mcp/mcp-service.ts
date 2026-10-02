import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type {
  McpServerInfo,
  McpServerUpsertInput,
  McpToolInfo,
  RawMcpEntry,
} from "../../shared/contracts";
import { getActiveAgentRun } from "../agent/agent-run-store";
import { registerMcpCitations } from "../agent/harness/mcp-citation-registry";
import { toolRegistry } from "../agent/tools/registry";
import { resolveAgentToolContext } from "../agent/tools/tool-context";
import {
  defaultMcpConfigPath,
  findRawMcpEntry,
  loadWorkspaceMcpConfig,
  MCP_CONFIG_TEMPLATE,
  type McpServerConfig,
  removeMcpServerEntry,
  setMcpServerEnabledEntry,
  upsertMcpServerEntry,
} from "./mcp-config";

/**
 * MCP runtime — connects the servers declared in mcp.json, bridges their tools
 * into the shared tool registry (so they flow through the same activation /
 * permission / UI pipeline as every other agent tool), and reports status to
 * the Settings UI.
 *
 * MCP servers are third-party code, so every bridged tool goes through the same
 * `mcp.call` permission path. Tool annotations remain UI hints only; they never
 * silently bypass user approval.
 */

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_MCP_TOOL_PAGES = 100;
const MAX_MCP_TOOLS_PER_SERVER = 500;
const MAX_MCP_CONTENT_BLOCKS = 50;
const MAX_MCP_CONTENT_BYTES = 64 * 1024;
const COMPOSIO_MCP_SERVER_NAME = "__modus_composio";
const COMPOSIO_TOOL_OWNER = Symbol("Composio MCP bridge");

type ManagedServer = {
  config: McpServerConfig;
  /** Identity of the config used for change detection on reload. */
  configKey: string;
  status: McpServerInfo["status"];
  error?: string | undefined;
  client?: Client | undefined;
  tools: McpToolInfo[];
};

/** name → managed connection. MCP servers are app-wide, like Cursor's. */
const servers = new Map<string, ManagedServer>();
/** Tool names currently registered per server, for clean unregistration. */
const registeredTools = new Map<string, string[]>();
/** Registered names have one owner so cleanup never unregisters another server. */
const registeredToolOwners = new Map<string, string | typeof COMPOSIO_TOOL_OWNER>();
/** Allowlist-selected names only, kept in sync with each server's registrations. */
const registeredAllowlistedTools = new Map<string, string[]>();

export type ComposioMcpSessionInput = {
  url: string;
  headers: Record<string, string>;
  allowedToolSlugs: string[];
};

export interface ComposioMcpBridge {
  inspectComposioMcpSession(
    input: Pick<ComposioMcpSessionInput, "url" | "headers">,
  ): Promise<McpToolInfo[]>;
  registerComposioMcpSession(input: ComposioMcpSessionInput): Promise<McpToolInfo[]>;
  unregisterComposioMcpSession(): Promise<void>;
}

type ManagedComposioSession = {
  client: Client;
  transport: StreamableHTTPClientTransport;
  toolNames: string[];
  tools: McpToolInfo[];
};

/** Hosted Composio tools are internal to the local selected-account policy. */
let composioSession: ManagedComposioSession | undefined;
let composioSessionGeneration = 0;

export type McpToolPermissionMode = "allowlisted" | "dangerous";

function encodeMcpIdentityPart(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  return `${bytes.length}_${bytes.toString("hex")}`;
}

export function mcpToolName(
  server: string,
  tool: string,
  permissionMode: McpToolPermissionMode = "dangerous",
): string {
  const prefix = `mcp_v1_${permissionMode}_`;
  const identity = `${encodeMcpIdentityPart(server)}_${encodeMcpIdentityPart(tool)}`;
  const encodedName = `${prefix}${identity}`;
  if (encodedName.length <= 64) return encodedName;
  // The full digest keeps long raw identities distinct within model name limits.
  // Its marker cannot overlap the length-prefixed encoding used by short names.
  return `${prefix}h_${createHash("sha256").update(identity).digest("base64url")}`;
}

function configKey(config: McpServerConfig): string {
  const { source: _source, ...identity } = config;
  return JSON.stringify(identity);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function closeClientAndTransport(
  client: Client,
  transport: { close: () => Promise<void> },
): Promise<void> {
  await Promise.all([client.close().catch(() => {}), transport.close().catch(() => {})]);
}

async function connectWithCleanup(
  client: Client,
  transport: Parameters<Client["connect"]>[0],
  label: string,
): Promise<void> {
  let timedOut = false;
  try {
    const connecting = client.connect(transport);
    void connecting.then(
      () => {
        if (timedOut) void closeClientAndTransport(client, transport);
      },
      () => {},
    );
    await withTimeout(connecting, CONNECT_TIMEOUT_MS, label);
  } catch (error) {
    timedOut = true;
    await closeClientAndTransport(client, transport);
    throw error;
  }
}

/**
 * On Windows, npm shims (npx.cmd, …) are not directly spawnable executables;
 * route stdio commands through cmd.exe exactly like a terminal would.
 */
function stdioSpawnSpec(config: Extract<McpServerConfig, { transport: "stdio" }>): {
  command: string;
  args: string[];
} {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", config.command, ...config.args] };
  }
  return { command: config.command, args: config.args };
}

async function createConnectedClient(config: McpServerConfig): Promise<Client> {
  const client = new Client({ name: "modus", version: "0.1.0" });

  if (config.transport === "stdio") {
    const spec = stdioSpawnSpec(config);
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: "ignore",
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    });
    await connectWithCleanup(client, transport, `connect ${config.name}`);
    return client;
  }

  // Remote servers: Streamable HTTP first (current spec), SSE as fallback
  // (legacy servers) — the same ladder Cursor and opencode use.
  const url = new URL(config.url);
  const headers = config.headers;
  try {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
    // Cast: the SDK's transport classes type `sessionId` as `string | undefined`
    // while its own Transport interface says `sessionId?: string`, which is
    // incompatible under exactOptionalPropertyTypes.
    await connectWithCleanup(
      client,
      transport as unknown as Parameters<Client["connect"]>[0],
      `connect ${config.name}`,
    );
    return client;
  } catch {
    const fallback = new Client({ name: "modus", version: "0.1.0" });
    const transport = new SSEClientTransport(url, { requestInit: { headers } });
    await connectWithCleanup(
      fallback,
      transport as unknown as Parameters<Client["connect"]>[0],
      `connect ${config.name}`,
    );
    return fallback;
  }
}

/** MCP inputSchema (JSON Schema) → the TSchema PI forwards to the model. */
function toParametersSchema(inputSchema: unknown): TSchema {
  const schema =
    typeof inputSchema === "object" && inputSchema !== null
      ? (inputSchema as Record<string, unknown>)
      : {};
  return {
    ...schema,
    type: "object",
    properties: schema.properties ?? {},
  } as unknown as TSchema;
}

type McpContentItem = {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
};

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let output = "";
  let used = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

function toAgentContent(
  items: readonly unknown[],
  appendedText?: string,
): (TextContent | ImageContent)[] {
  const parts: (TextContent | ImageContent)[] = [];
  const safeExtra = appendedText ? truncateUtf8(appendedText, MAX_MCP_CONTENT_BYTES) : "";
  const extraBytes = Buffer.byteLength(safeExtra, "utf8");
  const reservedSlots = safeExtra ? 1 : 0;
  const needsBlockMarker = items.length > MAX_MCP_CONTENT_BLOCKS - reservedSlots;
  const sourceSlots = MAX_MCP_CONTENT_BLOCKS - reservedSlots - (needsBlockMarker ? 1 : 0);
  const bodyByteBudget = MAX_MCP_CONTENT_BYTES - extraBytes;
  let bodyBytes = 0;
  const appendText = (value: string): void => {
    const text = truncateUtf8(value, bodyByteBudget - bodyBytes);
    if (!text) return;
    parts.push({ type: "text", text });
    bodyBytes += Buffer.byteLength(text, "utf8");
  };

  for (const rawItem of items.slice(0, sourceSlots)) {
    const item =
      rawItem !== null && typeof rawItem === "object" && !Array.isArray(rawItem)
        ? (rawItem as McpContentItem)
        : undefined;
    if (item?.type === "text" && typeof item.text === "string") {
      appendText(item.text);
    } else if (
      item?.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string" &&
      item.data.length > 0 &&
      item.mimeType.length > 0
    ) {
      const imageBytes =
        Buffer.byteLength(item.data, "utf8") + Buffer.byteLength(item.mimeType, "utf8");
      if (imageBytes <= bodyByteBudget - bodyBytes) {
        parts.push({ type: "image", data: item.data, mimeType: item.mimeType });
        bodyBytes += imageBytes;
      } else {
        appendText("[MCP image omitted: content limit exceeded.]");
      }
    } else {
      appendText("[Unsupported MCP content omitted.]");
    }
  }
  if (needsBlockMarker) appendText("[Additional MCP content omitted.]");
  if (safeExtra) parts.push({ type: "text", text: safeExtra });
  if (parts.length === 0) return [{ type: "text", text: "(no content)" }];
  return parts;
}

async function callToolWithDeadline(
  client: Client,
  toolName: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  if (signal?.aborted) throw new Error(`MCP tool ${toolName} call aborted.`);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAborted: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => {
    controller.abort();
    rejectAborted?.(new Error(`MCP tool ${toolName} call aborted.`));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`MCP tool ${toolName} timed out after ${CALL_TIMEOUT_MS}ms.`));
    }, CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      client.callTool({ name: toolName, arguments: params }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: false,
        signal: controller.signal,
      }),
      timeout,
      ...(signal ? [aborted] : []),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function buildToolDefinition(
  serverName: string,
  client: Client,
  tool: { name: string; description?: string | undefined; inputSchema?: unknown },
  readOnlyAllowlisted: boolean,
): ToolDefinition {
  const registeredName = mcpToolName(
    serverName,
    tool.name,
    readOnlyAllowlisted ? "allowlisted" : "dangerous",
  );
  return defineTool({
    name: registeredName,
    label: `${serverName}: ${tool.name}`,
    description:
      tool.description?.trim() || `Tool "${tool.name}" provided by the "${serverName}" MCP server.`,
    parameters: toParametersSchema(tool.inputSchema),
    execute: async (_toolCallId, params, signal, _onUpdate, toolContext) => {
      const result = await callToolWithDeadline(
        client,
        tool.name,
        (params ?? {}) as Record<string, unknown>,
        signal,
      );
      const resultContent: unknown[] =
        "content" in result && Array.isArray(result.content) ? result.content : [];
      if ("isError" in result && result.isError === true) {
        const content = toAgentContent(resultContent);
        const message = content
          .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
          .join("\n");
        throw new Error(message || `MCP tool ${tool.name} failed.`);
      }
      let citationText: string | undefined;
      if (readOnlyAllowlisted && "content" in result) {
        const owner = resolveAgentToolContext(toolContext.cwd);
        const activeRun = getActiveAgentRun(owner.sessionId);
        if (activeRun) {
          const citations = registerMcpCitations(
            owner.sessionId,
            activeRun.id,
            serverName,
            tool.name,
            result as CallToolResult,
          );
          if (citations.length > 0) {
            citationText = `MCP citations:\n${citations
              .map((citation) => {
                const source = citation.title ?? new URL(citation.url).hostname;
                return `[${citation.id}] ${citation.serverName}/${citation.toolName} — ${source}`;
              })
              .join("\n")}`;
          }
        }
      }
      const content = toAgentContent(resultContent, citationText);
      return { content, details: { server: serverName, tool: tool.name } };
    },
  });
}

function unregisterServerTools(serverName: string): void {
  for (const name of registeredTools.get(serverName) ?? []) {
    if (registeredToolOwners.get(name) === serverName) {
      toolRegistry.unregisterTool(name);
      registeredToolOwners.delete(name);
    }
  }
  registeredTools.delete(serverName);
  registeredAllowlistedTools.delete(serverName);
}

/** Currently registered allowlisted MCP tool names for the Librarian role. */
export function listAllowlistedMcpToolNames(): string[] {
  return [...new Set([...registeredAllowlistedTools.values()].flat())].sort((a, b) =>
    a.localeCompare(b),
  );
}

async function refreshServerTools(managed: ManagedServer): Promise<void> {
  const client = managed.client;
  if (!client) {
    return;
  }
  let listedTools: Awaited<ReturnType<typeof listAllMcpTools>>;
  try {
    listedTools = await listAllMcpTools(client, managed.config.name);
  } catch (error) {
    if (
      servers.get(managed.config.name) !== managed ||
      !managed.config.enabled ||
      managed.client !== client
    ) {
      return;
    }
    unregisterServerTools(managed.config.name);
    managed.tools = [];
    throw error;
  }

  if (
    servers.get(managed.config.name) !== managed ||
    !managed.config.enabled ||
    managed.client !== client
  ) {
    return;
  }

  unregisterServerTools(managed.config.name);
  managed.tools = [];
  const names: string[] = [];
  const tools: McpToolInfo[] = [];
  const rawToolNameCounts = new Map<string, number>();
  for (const tool of listedTools) {
    rawToolNameCounts.set(tool.name, (rawToolNameCounts.get(tool.name) ?? 0) + 1);
  }
  const candidates = listedTools.map((tool) => {
    const readOnlyAllowlisted = managed.config.readOnlyToolAllowlist.includes(tool.name);
    return {
      tool,
      readOnlyAllowlisted,
      registeredName: mcpToolName(
        managed.config.name,
        tool.name,
        readOnlyAllowlisted ? "allowlisted" : "dangerous",
      ),
    };
  });
  const candidateNames = new Set<string>();
  for (const candidate of candidates) {
    const owner = registeredToolOwners.get(candidate.registeredName);
    if (
      rawToolNameCounts.get(candidate.tool.name) !== 1 ||
      candidateNames.has(candidate.registeredName) ||
      (owner !== undefined && owner !== managed.config.name) ||
      (toolRegistry.getEntry(candidate.registeredName) !== undefined && owner === undefined)
    ) {
      throw new Error(`MCP tool registration name collision: ${candidate.registeredName}`);
    }
    candidateNames.add(candidate.registeredName);
  }

  const allowlistedNames: string[] = [];
  for (const { tool, readOnlyAllowlisted } of candidates) {
    const definition = buildToolDefinition(managed.config.name, client, tool, readOnlyAllowlisted);
    toolRegistry.registerTool({
      entry: {
        name: definition.name,
        profiles: readOnlyAllowlisted ? ["chat", "plan"] : ["chat"],
        permission: readOnlyAllowlisted
          ? { danger: "safe" }
          : { danger: "dangerous", action: "mcp.call" },
        ...(readOnlyAllowlisted ? { capabilities: ["read"] } : {}),
        ui: { verb: managed.config.name },
      },
      definition,
    });
    names.push(definition.name);
    registeredToolOwners.set(definition.name, managed.config.name);
    if (readOnlyAllowlisted) allowlistedNames.push(definition.name);
    tools.push({
      name: tool.name,
      registeredName: definition.name,
      description: tool.description,
    });
  }
  registeredTools.set(managed.config.name, names);
  registeredAllowlistedTools.set(managed.config.name, allowlistedNames);
  managed.tools = tools;
}

export async function listAllMcpTools(
  client: Pick<Client, "listTools">,
  serverName: string,
): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]> {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < MAX_MCP_TOOL_PAGES; pageNumber += 1) {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new Error(`MCP server ${serverName} repeated a tool-list cursor.`);
      }
      seenCursors.add(cursor);
    }
    const page = await withTimeout(
      client.listTools(cursor === undefined ? undefined : { cursor }),
      CONNECT_TIMEOUT_MS,
      `list tools ${serverName}`,
    );
    if (tools.length + page.tools.length > MAX_MCP_TOOLS_PER_SERVER) {
      throw new Error(
        `MCP server ${serverName} exceeded the ${MAX_MCP_TOOLS_PER_SERVER}-tool limit.`,
      );
    }
    tools.push(...page.tools);
    const nextCursor = page.nextCursor;
    if (!nextCursor) return tools;
    if (seenCursors.has(nextCursor)) {
      throw new Error(`MCP server ${serverName} repeated a tool-list cursor.`);
    }
    if (pageNumber + 1 >= MAX_MCP_TOOL_PAGES) {
      throw new Error(`MCP server ${serverName} exceeded the ${MAX_MCP_TOOL_PAGES}-page limit.`);
    }
    cursor = nextCursor;
  }
  throw new Error(`MCP server ${serverName} exceeded the ${MAX_MCP_TOOL_PAGES}-page limit.`);
}

async function connectServer(managed: ManagedServer): Promise<void> {
  managed.status = "connecting";
  managed.error = undefined;
  try {
    const client = await createConnectedClient(managed.config);
    if (servers.get(managed.config.name) !== managed || !managed.config.enabled) {
      await client.close().catch(() => {});
      return;
    }
    managed.client = client;

    // Servers may add/remove tools at runtime; keep the registry in sync.
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void refreshServerTools(managed).catch(() => {});
    });
    client.onclose = () => {
      if (servers.get(managed.config.name) === managed && managed.client === client) {
        managed.client = undefined;
        if (managed.status === "connected") {
          managed.status = "failed";
          managed.error = "Connection closed.";
        }
        unregisterServerTools(managed.config.name);
      }
    };

    await refreshServerTools(managed);
    if (servers.get(managed.config.name) === managed && managed.config.enabled) {
      managed.status = "connected";
    }
  } catch (error) {
    if (servers.get(managed.config.name) !== managed || !managed.config.enabled) {
      return;
    }
    managed.status = "failed";
    managed.error = error instanceof Error ? error.message : String(error);
    managed.tools = [];
    await managed.client?.close().catch(() => {});
    managed.client = undefined;
  }
}

function detachComposioSession(): ManagedComposioSession | undefined {
  const current = composioSession;
  composioSession = undefined;
  if (!current) return undefined;
  for (const name of current.toolNames) {
    if (registeredToolOwners.get(name) === COMPOSIO_TOOL_OWNER) {
      toolRegistry.unregisterTool(name);
      registeredToolOwners.delete(name);
    }
  }
  return current;
}

async function closeComposioSession(session: ManagedComposioSession | undefined): Promise<void> {
  if (session) await closeClientAndTransport(session.client, session.transport);
}

/** Remove the hosted Composio registration without touching workspace servers. */
export async function unregisterComposioMcpSession(): Promise<void> {
  composioSessionGeneration += 1;
  const previous = detachComposioSession();
  await closeComposioSession(previous);
}

function validateComposioMcpCredentials(input: Pick<ComposioMcpSessionInput, "url" | "headers">): {
  url: URL;
  headers: Record<string, string>;
} {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("Composio returned an invalid MCP session URL.");
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new Error("Composio MCP sessions must use a credential-free HTTPS URL.");
  }
  const headers = Object.fromEntries(
    Object.entries(input.headers).filter(
      ([name, value]) => name.trim().length > 0 && typeof value === "string" && value.length > 0,
    ),
  );
  if (Object.keys(headers).length === 0) {
    throw new Error("Composio MCP session headers are missing.");
  }
  return { url, headers };
}

/** Discover hosted tools using a temporary connection, without changing registrations. */
export async function inspectComposioMcpSession(
  input: Pick<ComposioMcpSessionInput, "url" | "headers">,
): Promise<McpToolInfo[]> {
  const { url, headers } = validateComposioMcpCredentials(input);
  const client = new Client({ name: "modus", version: "0.1.0" });
  let transport: StreamableHTTPClientTransport | undefined;
  try {
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers, redirect: "error" },
    });
    await connectWithCleanup(
      client,
      transport as unknown as Parameters<Client["connect"]>[0],
      "connect Composio MCP inspection",
    );
    const tools = await listAllMcpTools(client, COMPOSIO_MCP_SERVER_NAME);
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      registeredName: mcpToolName(COMPOSIO_MCP_SERVER_NAME, tool.name),
    }));
  } finally {
    if (transport) await closeClientAndTransport(client, transport);
    else await client.close().catch(() => {});
  }
}

/**
 * Connect the single hosted session used by Composio, exposing only exact
 * selected operation slugs through the normal dangerous `mcp.call` path.
 */
export async function registerComposioMcpSession(
  input: ComposioMcpSessionInput,
): Promise<McpToolInfo[]> {
  const generation = ++composioSessionGeneration;
  const previous = detachComposioSession();
  await closeComposioSession(previous);
  if (generation !== composioSessionGeneration) {
    throw new Error("Composio session registration was superseded.");
  }

  const selectedToolSlugs = [...new Set(input.allowedToolSlugs)];
  if (selectedToolSlugs.length > MAX_MCP_TOOLS_PER_SERVER) {
    throw new Error(
      `Composio cannot register more than ${MAX_MCP_TOOLS_PER_SERVER} selected operations.`,
    );
  }
  if (selectedToolSlugs.some((slug) => typeof slug !== "string" || slug.trim().length === 0)) {
    throw new Error("Composio selected operations must have non-empty names.");
  }
  if (selectedToolSlugs.length === 0) return [];

  const { url, headers } = validateComposioMcpCredentials(input);

  const client = new Client({ name: "modus", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers, redirect: "error" },
  });
  try {
    await connectWithCleanup(
      client,
      transport as unknown as Parameters<Client["connect"]>[0],
      "connect Composio MCP session",
    );
    if (generation !== composioSessionGeneration) {
      await closeClientAndTransport(client, transport);
      throw new Error("Composio session registration was superseded.");
    }

    const listedTools = await listAllMcpTools(client, COMPOSIO_MCP_SERVER_NAME);
    if (generation !== composioSessionGeneration) {
      await closeClientAndTransport(client, transport);
      throw new Error("Composio session registration was superseded.");
    }

    const allowed = new Set(selectedToolSlugs);
    const selectedTools = listedTools.filter((tool) => allowed.has(tool.name));
    const selectedNames = new Set(selectedTools.map((tool) => tool.name));
    if (
      selectedTools.length !== selectedToolSlugs.length ||
      selectedNames.size !== selectedToolSlugs.length
    ) {
      throw new Error("One or more selected Composio operations are missing or ambiguous.");
    }

    const definitions = selectedTools.map((tool) =>
      buildToolDefinition(COMPOSIO_MCP_SERVER_NAME, client, tool, false),
    );
    const candidateNames = new Set<string>();
    for (const definition of definitions) {
      const owner = registeredToolOwners.get(definition.name);
      if (
        candidateNames.has(definition.name) ||
        owner !== undefined ||
        toolRegistry.getEntry(definition.name) !== undefined
      ) {
        throw new Error(`Composio MCP tool registration name collision: ${definition.name}`);
      }
      candidateNames.add(definition.name);
    }

    const registeredNames: string[] = [];
    try {
      for (const definition of definitions) {
        toolRegistry.registerTool({
          entry: {
            name: definition.name,
            profiles: ["chat"],
            permission: { danger: "dangerous", action: "mcp.call" },
            ui: { verb: "Composio" },
          },
          definition,
        });
        registeredToolOwners.set(definition.name, COMPOSIO_TOOL_OWNER);
        registeredNames.push(definition.name);
      }
    } catch (error) {
      for (const name of registeredNames) {
        if (registeredToolOwners.get(name) === COMPOSIO_TOOL_OWNER) {
          toolRegistry.unregisterTool(name);
          registeredToolOwners.delete(name);
        }
      }
      throw error;
    }

    const tools: McpToolInfo[] = selectedTools.map((tool, index) => ({
      name: tool.name,
      registeredName: definitions[index]?.name ?? mcpToolName(COMPOSIO_MCP_SERVER_NAME, tool.name),
      description: tool.description,
    }));
    const managed: ManagedComposioSession = {
      client,
      transport,
      toolNames: registeredNames,
      tools,
    };
    composioSession = managed;
    client.onclose = () => {
      if (composioSession === managed) {
        void closeComposioSession(detachComposioSession());
      }
    };
    return tools;
  } catch (error) {
    await closeClientAndTransport(client, transport);
    throw error;
  }
}

async function disposeServer(name: string): Promise<void> {
  const managed = servers.get(name);
  if (!managed) {
    return;
  }
  unregisterServerTools(name);
  servers.delete(name);
  await managed.client?.close().catch(() => {});
}

/**
 * Reconcile running servers with the mcp.json files visible from `cwd`.
 * Unchanged servers keep their connections; changed/removed ones are torn
 * down; new ones connect in parallel. Returns the resulting status list.
 */
export async function syncWorkspaceMcp(
  cwd: string,
  options: { waitForConnections?: boolean } = {},
): Promise<McpServerInfo[]> {
  const configs = loadWorkspaceMcpConfig(cwd).servers.map((config) =>
    config.transport === "stdio" && config.cwd === undefined ? { ...config, cwd } : config,
  );
  const desired = new Map(configs.map((config) => [config.name, config]));

  const removals: Promise<void>[] = [];
  for (const name of servers.keys()) {
    const next = desired.get(name);
    const current = servers.get(name);
    if (!next || (current && current.configKey !== configKey(next))) {
      removals.push(disposeServer(name));
    }
  }
  await Promise.all(removals);

  const connections: Promise<void>[] = [];
  for (const config of configs) {
    if (servers.has(config.name)) {
      continue;
    }
    const managed: ManagedServer = {
      config,
      configKey: configKey(config),
      status: config.enabled ? "connecting" : "disabled",
      tools: [],
    };
    servers.set(config.name, managed);
    if (config.enabled) {
      connections.push(connectServer(managed));
    }
  }
  const connect = Promise.all(connections);
  if (options.waitForConnections === false) {
    void connect.catch(() => {});
  } else {
    await connect;
  }

  return listMcpServers();
}

export function listMcpServers(): McpServerInfo[] {
  return [...servers.values()]
    .map((managed) => ({
      name: managed.config.name,
      transport: managed.config.transport,
      source: managed.config.source,
      status: managed.status,
      error: managed.error,
      tools: managed.tools,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Ensure an editable mcp.json exists for the workspace; returns its path. */
export function ensureMcpConfigFile(cwd: string): string {
  const path = defaultMcpConfigPath(cwd);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, MCP_CONFIG_TEMPLATE, "utf8");
  }
  return path;
}

/** Create/update a server from the Settings form, then reconnect. */
export async function upsertMcpServer(
  cwd: string,
  input: McpServerUpsertInput,
): Promise<McpServerInfo[]> {
  upsertMcpServerEntry(cwd, input);
  return await syncWorkspaceMcp(cwd, { waitForConnections: false });
}

/** Delete a server from its config file, then reconcile connections. */
export async function deleteMcpServer(cwd: string, name: string): Promise<McpServerInfo[]> {
  removeMcpServerEntry(cwd, name);
  return await syncWorkspaceMcp(cwd);
}

/** Toggle a server on/off in place, then reconcile connections. */
export async function setMcpServerEnabled(
  cwd: string,
  name: string,
  enabled: boolean,
): Promise<McpServerInfo[]> {
  setMcpServerEnabledEntry(cwd, name, enabled);
  return await syncWorkspaceMcp(cwd);
}

/** Raw (un-interpolated) entry for the edit form. */
export function getMcpServerEntry(cwd: string, name: string): RawMcpEntry | undefined {
  return findRawMcpEntry(cwd, name);
}

/** App-shutdown cleanup: close every transport (kills stdio children). */
export async function disposeAllMcp(): Promise<void> {
  await Promise.all([
    ...[...servers.keys()].map((name) => disposeServer(name)),
    unregisterComposioMcpSession(),
  ]);
}
