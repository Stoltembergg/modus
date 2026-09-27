import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as citationRegistry from "../agent/harness/mcp-citation-registry";
import { toolRegistry } from "../agent/tools/registry";
import { runWithAgentToolContext } from "../agent/tools/tool-context";
import { defaultMcpConfigPath } from "./mcp-config";

type MockCloseable = { close: ReturnType<typeof vi.fn> };
type MockClient = MockCloseable & { transport?: MockCloseable | undefined };

const mcpMock = vi.hoisted(() => ({
  tools: [] as Array<Record<string, unknown>>,
  callResult: { content: [] as unknown[] } as Record<string, unknown>,
  activeRuns: new Map<string, { id: string }>(),
  callOptions: [] as Array<Record<string, unknown>>,
  neverResolveCall: false,
  callObservedAbort: false,
  clients: [] as MockClient[],
  transports: [] as MockCloseable[],
  connect: undefined as (() => Promise<void>) | undefined,
  listTools: undefined as (() => Promise<{ tools: Array<Record<string, unknown>> }>) | undefined,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    onclose?: () => void;
    transport: MockCloseable | undefined;
    close = vi.fn(async () => {});
    constructor() {
      mcpMock.clients.push(this);
    }
    async connect(transport: unknown): Promise<void> {
      this.transport = transport as MockCloseable;
      await mcpMock.connect?.();
    }
    setNotificationHandler(): void {}
    async listTools(): Promise<{ tools: Array<Record<string, unknown>> }> {
      if (mcpMock.listTools) return await mcpMock.listTools();
      return { tools: mcpMock.tools };
    }
    async callTool(
      _params: unknown,
      _resultSchema: unknown,
      options?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      mcpMock.callOptions.push(options ?? {});
      if (mcpMock.neverResolveCall) {
        return await new Promise((_resolve, reject) => {
          const signal = options?.signal as AbortSignal | undefined;
          signal?.addEventListener(
            "abort",
            () => {
              mcpMock.callObservedAbort = true;
              reject(new Error("mock call aborted"));
            },
            { once: true },
          );
        });
      }
      return mcpMock.callResult;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  getDefaultEnvironment: () => ({}),
  StdioClientTransport: class {
    close = vi.fn(async () => {});
    constructor() {
      mcpMock.transports.push(this);
    }
  },
}));

vi.mock("../agent/agent-run-store", () => ({
  getActiveAgentRun: (sessionId: string) => mcpMock.activeRuns.get(sessionId),
}));

import {
  disposeAllMcp,
  listAllMcpTools,
  listAllowlistedMcpToolNames,
  mcpToolName,
  setMcpServerEnabled,
  syncWorkspaceMcp,
} from "./mcp-service";

let cwd: string;

function getMockClient(index = 0): MockClient {
  const client = mcpMock.clients[index];
  if (!client) throw new Error(`Mock MCP client ${index} was not created.`);
  return client;
}

function getMockTransport(client: MockClient): MockCloseable {
  const transport = client.transport;
  if (!transport) throw new Error("Mock MCP transport was not created.");
  return transport;
}

async function configureServer(readOnlyToolAllowlist: string[]): Promise<void> {
  await configureServers({
    docs: {
      command: "mock-mcp",
      args: [],
      readOnlyToolAllowlist,
    },
  });
}

async function configureServers(servers: Record<string, Record<string, unknown>>): Promise<void> {
  await mkdir(join(cwd, ".modus"), { recursive: true });
  await writeFile(defaultMcpConfigPath(cwd), JSON.stringify({ mcpServers: servers }));
  await syncWorkspaceMcp(cwd);
}

async function executeTool(
  name: string,
): Promise<{ content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }> {
  const tool = toolRegistry.getCustomToolDefinitions("chat").find((entry) => entry.name === name);
  if (!tool?.execute) throw new Error(`MCP tool not registered: ${name}`);
  return await runWithAgentToolContext(
    { workspaceId: "workspace", sessionId: "citation-session", cwd, profile: "chat" },
    () =>
      tool.execute?.("call-id", {}, new AbortController().signal, undefined, { cwd } as Parameters<
        NonNullable<typeof tool.execute>
      >[4]) as Promise<{
        content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      }>,
  );
}

beforeEach(async () => {
  await disposeAllMcp();
  cwd = await mkdtemp(join(tmpdir(), "modus-mcp-service-test-"));
  mcpMock.tools = [];
  mcpMock.callResult = { content: [] };
  mcpMock.activeRuns.clear();
  mcpMock.callOptions = [];
  mcpMock.neverResolveCall = false;
  mcpMock.callObservedAbort = false;
  mcpMock.clients = [];
  mcpMock.transports = [];
  mcpMock.connect = undefined;
  mcpMock.listTools = undefined;
});

afterEach(async () => {
  await disposeAllMcp();
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  vi.restoreAllMocks();
});

describe("listAllMcpTools", () => {
  it("follows MCP pagination cursors", async () => {
    const cursors: Array<string | undefined> = [];
    const client = {
      async listTools(params?: { cursor?: string }) {
        cursors.push(params?.cursor);
        if (!params?.cursor) {
          return {
            tools: [{ name: "first", inputSchema: { type: "object" as const } }],
            nextCursor: "next",
          };
        }
        return { tools: [{ name: "second", inputSchema: { type: "object" as const } }] };
      },
    };

    await expect(listAllMcpTools(client, "server")).resolves.toMatchObject([
      { name: "first" },
      { name: "second" },
    ]);
    expect(cursors).toEqual([undefined, "next"]);
  });

  it("rejects repeated pagination cursors instead of looping", async () => {
    let calls = 0;
    const client = {
      async listTools() {
        calls += 1;
        return { tools: [], nextCursor: "repeat" };
      },
    };

    await expect(listAllMcpTools(client, "looping-server")).rejects.toThrow(/cursor/i);
    expect(calls).toBe(2);
  });

  it("rejects tool and page caps without returning partial pages", async () => {
    const oversizedTools = {
      async listTools() {
        return {
          tools: Array.from({ length: 501 }, (_, index) => ({
            name: `tool-${index}`,
            inputSchema: { type: "object" as const },
          })),
        };
      },
    };
    await expect(listAllMcpTools(oversizedTools, "large-server")).rejects.toThrow(/limit/i);

    let calls = 0;
    const manyPages = {
      async listTools() {
        calls += 1;
        return { tools: [], nextCursor: `cursor-${calls}` };
      },
    };
    await expect(listAllMcpTools(manyPages, "many-pages-server")).rejects.toThrow(/page/i);
    expect(calls).toBe(100);
  });
});

describe("MCP server lifecycle", () => {
  it("closes a client that finishes connecting after the server is disabled", async () => {
    const connecting = deferred<void>();
    mcpMock.connect = () => connecting.promise;
    await writeLifecycleConfig(true);

    await syncWorkspaceMcp(cwd, { waitForConnections: false });
    await setMcpServerEnabled(cwd, "lifecycle", false);
    connecting.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getMockClient().close).toHaveBeenCalled();
  });

  it("does not register tools from a list request that finishes after disable", async () => {
    const listing = deferred<{ tools: Array<Record<string, unknown>> }>();
    let listStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      listStarted = resolve;
    });
    mcpMock.listTools = () => {
      listStarted();
      return listing.promise;
    };
    await writeLifecycleConfig(true);

    const syncing = syncWorkspaceMcp(cwd);
    await started;
    await setMcpServerEnabled(cwd, "lifecycle", false);
    listing.resolve({ tools: [{ name: "stale-tool", inputSchema: { type: "object" } }] });
    await syncing;

    expect(toolRegistry.getEntry(mcpToolName("lifecycle", "stale-tool"))).toBeUndefined();
  });

  it("closes both client and transport on timeout, including late completion", async () => {
    vi.useFakeTimers();
    const connecting = deferred<void>();
    mcpMock.connect = () => connecting.promise;
    await writeLifecycleConfig(true);

    const syncing = syncWorkspaceMcp(cwd);
    await vi.advanceTimersByTimeAsync(15_000);
    await syncing;
    connecting.resolve();
    await Promise.resolve();

    const client = getMockClient();
    expect(client.close).toHaveBeenCalled();
    expect(getMockTransport(client).close).toHaveBeenCalled();
  });

  it("closes client and transport when connect fails", async () => {
    mcpMock.connect = () => Promise.reject(new Error("connect failed"));
    await writeLifecycleConfig(true);

    await syncWorkspaceMcp(cwd);

    const client = getMockClient();
    expect(client.close).toHaveBeenCalled();
    expect(getMockTransport(client).close).toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function writeLifecycleConfig(enabled: boolean): Promise<void> {
  await mkdir(join(cwd, ".modus"), { recursive: true });
  await writeFile(
    defaultMcpConfigPath(cwd),
    JSON.stringify({
      mcpServers: {
        lifecycle: {
          command: "mock-mcp",
          args: [],
          readOnlyToolAllowlist: [],
          ...(enabled ? {} : { disabled: true }),
        },
      },
    }),
  );
}

describe("MCP registered tool identity", () => {
  it("uses injective names and permission-specific versions for raw identities", () => {
    const dotted = mcpToolName("docs.v1", "search", "allowlisted");
    const underscored = mcpToolName("docs_v1", "search", "allowlisted");
    const dangerous = mcpToolName("docs.v1", "search", "dangerous");

    expect(dotted.startsWith("mcp_")).toBe(true);
    expect(dotted).not.toBe(underscored);
    expect(dotted).not.toBe(dangerous);
  });

  it("keeps cross-server registrations distinct and unregisters only the removed owner", async () => {
    mcpMock.tools = [{ name: "search", inputSchema: { type: "object" } }];
    await configureServers({
      "docs.v1": { command: "mock-mcp", args: [], readOnlyToolAllowlist: ["search"] },
      docs_v1: { command: "mock-mcp", args: [], readOnlyToolAllowlist: ["search"] },
    });
    const dottedName = mcpToolName("docs.v1", "search", "allowlisted");
    const underscoredName = mcpToolName("docs_v1", "search", "allowlisted");
    expect(new Set(listAllowlistedMcpToolNames())).toEqual(new Set([dottedName, underscoredName]));
    expect(toolRegistry.getEntry(dottedName)).toBeDefined();
    expect(toolRegistry.getEntry(underscoredName)).toBeDefined();
    expect(toolRegistry.getEntry(dottedName)?.ui.verb).toBe("docs.v1");
    expect(
      toolRegistry.getCustomToolDefinitions("chat").find((tool) => tool.name === dottedName)?.label,
    ).toBe("docs.v1: search");

    await configureServers({
      "docs.v1": { command: "mock-mcp", args: [], readOnlyToolAllowlist: ["search"] },
    });

    expect(listAllowlistedMcpToolNames()).toEqual([dottedName]);
    expect(toolRegistry.getEntry(dottedName)).toBeDefined();
    expect(toolRegistry.getEntry(underscoredName)).toBeUndefined();
    expect(
      toolRegistry.classify({
        type: "tool_call",
        toolCallId: "stale",
        toolName: underscoredName,
        input: {},
      } as never),
    ).toEqual({
      action: "mcp.call",
      dangerous: true,
    });
  });

  it("changes registration identity when a captured tool becomes dangerous", async () => {
    mcpMock.tools = [{ name: "search", inputSchema: { type: "object" } }];
    await configureServer(["search"]);
    const capturedSafe = toolRegistry
      .getCustomToolDefinitions("chat")
      .find((tool) => tool.name === mcpToolName("docs", "search", "allowlisted"));
    expect(capturedSafe).toBeDefined();

    await configureServer([]);
    const safeName = mcpToolName("docs", "search", "allowlisted");
    const dangerousName = mcpToolName("docs", "search", "dangerous");
    expect(capturedSafe?.name).toBe(safeName);
    expect(safeName).not.toBe(dangerousName);
    expect(toolRegistry.getEntry(safeName)).toBeUndefined();
    expect(toolRegistry.getEntry(dangerousName)).toMatchObject({
      permission: { danger: "dangerous", action: "mcp.call" },
    });
    expect(
      toolRegistry.classify({
        type: "tool_call",
        toolCallId: "stale",
        toolName: safeName,
        input: {},
      } as never),
    ).toEqual({
      action: "mcp.call",
      dangerous: true,
    });
  });
});

describe("MCP read-only allowlist", () => {
  it("registers only exact raw allowlisted names as safe read tools for chat and plan", async () => {
    mcpMock.tools = [
      { name: "read.search", inputSchema: { type: "object" } },
      { name: "read.search.extra", inputSchema: { type: "object" } },
    ];
    await configureServer(["read.search"]);

    const safeName = mcpToolName("docs", "read.search", "allowlisted");
    const similarName = mcpToolName("docs", "read.search.extra", "dangerous");
    expect(listAllowlistedMcpToolNames()).toEqual([safeName]);
    expect(toolRegistry.getEntry(safeName)).toMatchObject({
      profiles: ["chat", "plan"],
      permission: { danger: "safe" },
      capabilities: ["read"],
    });
    expect(toolRegistry.isReadOnlySafe(safeName)).toBe(true);
    expect(toolRegistry.getEntry(similarName)).toMatchObject({
      profiles: ["chat"],
      permission: { danger: "dangerous", action: "mcp.call" },
    });
    expect(toolRegistry.getCustomToolDefinitions("plan").map((tool) => tool.name)).toContain(
      safeName,
    );
    await disposeAllMcp();
    expect(listAllowlistedMcpToolNames()).toEqual([]);
  });

  it("keeps sanitized-name collisions distinct and checks the exact raw allowlist entry", async () => {
    mcpMock.tools = [
      { name: "read.search", inputSchema: { type: "object" } },
      { name: "read_search", inputSchema: { type: "object" } },
    ];
    await configureServer(["read.search"]);

    expect(listAllowlistedMcpToolNames()).toEqual([
      mcpToolName("docs", "read.search", "allowlisted"),
    ]);
    expect(toolRegistry.getEntry(mcpToolName("docs", "read.search", "allowlisted"))).toMatchObject({
      permission: { danger: "safe" },
    });
    expect(toolRegistry.getEntry(mcpToolName("docs", "read_search", "dangerous"))).toMatchObject({
      profiles: ["chat"],
      permission: { danger: "dangerous", action: "mcp.call" },
    });
  });

  it("appends a main-issued citation reference only for successful allowlisted results", async () => {
    mcpMock.tools = [
      { name: "search", inputSchema: { type: "object" } },
      { name: "mutate", inputSchema: { type: "object" } },
    ];
    mcpMock.callResult = {
      content: [
        {
          type: "resource_link",
          uri: "https://docs.example.test/guide",
          name: "Guide",
        },
      ],
    } satisfies CallToolResult;
    mcpMock.activeRuns.set("citation-session", { id: "citation-run" });
    await configureServer(["search"]);

    const registerSpy = vi.spyOn(citationRegistry, "registerMcpCitations");
    const allowedName = mcpToolName("docs", "search", "allowlisted");
    const dangerousName = mcpToolName("docs", "mutate", "dangerous");
    const allowedOutput = await executeTool(allowedName);
    const citation = registerCitationFromOutput(allowedOutput);
    expect(citation).toBeDefined();
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(allowedOutput.content?.some((part) => part.text?.includes(citation?.id ?? ""))).toBe(
      true,
    );
    expect(
      citationRegistry.resolveMcpCitation("citation-session", "citation-run", citation?.id ?? ""),
    ).toMatchObject({
      serverName: "docs",
      toolName: "search",
      url: "https://docs.example.test/guide",
    });

    mcpMock.callResult = {
      isError: true,
      content: [{ type: "resource_link", uri: "https://failed.example.test", name: "Failed" }],
    } satisfies CallToolResult;
    await expect(executeTool(allowedName)).rejects.toThrow();
    expect(registerSpy).toHaveBeenCalledTimes(1);

    mcpMock.callResult = {
      content: [
        { type: "resource_link", uri: "https://untrusted.example.test", name: "Untrusted" },
      ],
    } satisfies CallToolResult;
    const unallowlistedOutput = await executeTool(dangerousName);
    expect(unallowlistedOutput.content?.some((part) => part.text?.includes("MCP citations:"))).toBe(
      false,
    );
    expect(registerSpy).toHaveBeenCalledTimes(1);
    registerSpy.mockRestore();
  });

  it("bounds returned MCP blocks and bytes without serializing arbitrary bodies", async () => {
    mcpMock.tools = [{ name: "search", inputSchema: { type: "object" } }];
    mcpMock.activeRuns.set("citation-session", { id: "bounded-run" });
    mcpMock.callResult = {
      content: [
        { type: "text", text: "T".repeat(100_000) },
        { type: "image", data: "BINARY_SECRET".repeat(10_000), mimeType: "image/png" },
        { type: "audio", secretBody: "UNKNOWN_BODY_SECRET" },
        {
          type: "resource",
          resource: {
            uri: "https://docs.example.test/source",
            name: "Source",
            text: "EMBEDDED_SOURCE_SECRET",
          },
        },
        ...Array.from({ length: 60 }, (_, index) => ({ type: "text", text: `extra-${index}` })),
      ],
    };
    await configureServer(["search"]);

    const output = await executeTool(mcpToolName("docs", "search", "allowlisted"));
    const content = output.content ?? [];
    const utf8Bytes = content.reduce((sum, item) => {
      if (item.type === "text") return sum + Buffer.byteLength(item.text ?? "", "utf8");
      if (item.type === "image") {
        return (
          sum +
          Buffer.byteLength(item.data ?? "", "utf8") +
          Buffer.byteLength(item.mimeType ?? "", "utf8")
        );
      }
      return sum;
    }, 0);
    const text = content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");

    expect(content.length).toBeLessThanOrEqual(50);
    expect(utf8Bytes).toBeLessThanOrEqual(64 * 1024);
    expect(text).toContain("MCP citations:");
    expect(text).not.toContain("BINARY_SECRET");
    expect(text).not.toContain("UNKNOWN_BODY_SECRET");
    expect(text).not.toContain("EMBEDDED_SOURCE_SECRET");
  });

  it("aborts a non-resolving tool call at the absolute deadline", async () => {
    mcpMock.tools = [{ name: "search", inputSchema: { type: "object" } }];
    mcpMock.neverResolveCall = true;
    await configureServer(["search"]);
    const toolName = mcpToolName("docs", "search", "allowlisted");

    vi.useFakeTimers();
    try {
      const execution = executeTool(toolName);
      const settlement = execution.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mcpMock.callOptions[0]?.resetTimeoutOnProgress).toBe(false);
      expect(mcpMock.callObservedAbort).toBe(true);
      expect(await settlement).toMatchObject({ message: expect.stringMatching(/timed out/i) });
    } finally {
      vi.useRealTimers();
    }
  });
});

function registerCitationFromOutput(output: { content?: Array<{ text?: string }> }) {
  const text = output.content?.find((part) => part.text?.includes("MCP citations:"))?.text ?? "";
  const id = /\[([0-9a-f-]{36})\]/i.exec(text)?.[1];
  return id
    ? citationRegistry.resolveMcpCitation("citation-session", "citation-run", id)
    : undefined;
}
