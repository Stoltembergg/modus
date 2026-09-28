import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCommandCodeRequest,
  commandCodeStream,
  mapCommandCodeResponse,
} from "./commandcode-adapter";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of stream) result.push(item);
  return result;
}

afterEach(() => vi.unstubAllGlobals());

describe("Command Code adapter", () => {
  it("preserves model ID and sends only supported conversation fields", () => {
    const request = buildCommandCodeRequest(
      {
        modelId: "Qwen/Qwen3.7-Flash",
        systemPrompt: "Use tools when needed.",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        maxTokens: 4096,
      },
      { apiKey: "user_test_secret", sessionId: "session-1" },
    );

    expect(request.url).toBe("https://api.commandcode.ai/alpha/generate");
    expect(request.headers.Authorization).toBe("Bearer user_test_secret");
    expect(request.headers["x-project-slug"]).not.toBe("opencode");
    expect(request.body.params.model).toBe("Qwen/Qwen3.7-Flash");
    expect(request.body.params.stream).toBe(true);
    expect(request.body.params.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    expect(request.body).not.toHaveProperty("memory.projectMemory");
    expect(request.body.params.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(request.body.params.system).toBe("Use tools when needed.");
  });

  it("matches the pinned generate request envelope and truthful service headers", () => {
    const request = buildCommandCodeRequest(
      {
        modelId: "Qwen/Qwen3.7-Flash",
        systemPrompt: "Be concise.",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        maxTokens: 4096,
      },
      { apiKey: "test-key" },
    );

    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
      "x-project-slug": "modus",
      "x-command-code-version": "modus-native-adapter/0.1.0",
      "x-cli-environment": "production",
    });
    expect(
      Object.keys(request.headers).some(
        (name) => /opencode|version/i.test(name) && name !== "x-command-code-version",
      ),
    ).toBe(false);
    expect(request.body).toEqual({
      config: {},
      memory: "",
      taste: "",
      skills: null,
      permissionMode: "standard",
      params: {
        model: "Qwen/Qwen3.7-Flash",
        stream: true,
        system: "Be concise.",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            name: "read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        max_tokens: 4096,
      },
    });
  });

  it("serializes a completed Pi tool result as the pinned tool continuation", () => {
    const request = buildCommandCodeRequest(
      {
        modelId: "Qwen/Qwen3.7-Flash",
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "read",
                output: [{ type: "text", text: "file contents" }],
              },
            ],
          },
        ],
        tools: [],
      },
      { apiKey: "test-key" },
    );

    expect(request.body.params.messages).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
    ]);
  });

  it("converts an actual Pi ToolResultMessage success into a Command Code continuation", () => {
    const request = buildCommandCodeRequest(
      {
        modelId: "Qwen/Qwen3.7-Flash",
        messages: [
          {
            role: "toolResult",
            toolCallId: "call-real-success",
            toolName: "read",
            content: [{ type: "text", text: "file contents" }],
            isError: false,
            timestamp: 1_000,
          },
        ],
        tools: [],
      },
      { apiKey: "test-key" },
    );

    expect(request.body.params.messages).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-real-success",
            toolName: "read",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
    ]);
  });

  it("serializes an actual assistant Pi tool call through commandCodeStream", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          `data: ${JSON.stringify({ type: "finish-step", finishReason: "tool-calls" })}\n`,
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const assistantMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-context-call",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage: {},
      stopReason: "toolUse",
      timestamp: 1_002,
    };

    await collect(
      commandCodeStream(
        { id: "Qwen/Qwen3.7-Flash" } as never,
        {
          messages: [assistantMessage],
        } as never,
        { apiKey: "test-key" } as never,
      ),
    );

    expect(
      JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string).params.messages,
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-context-call",
            toolName: "read",
            input: { path: "README.md" },
          },
        ],
      },
    ]);
  });

  it("serializes actual Pi ToolResultMessage success and error through commandCodeStream", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          `data: ${JSON.stringify({ type: "finish-step", finishReason: "tool-calls" })}\n`,
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const success = {
      role: "toolResult",
      toolCallId: "call-real-success",
      toolName: "read",
      content: [
        { type: "text", text: "file contents", extra: "discard me" },
        { type: "image", data: "not part of text output", extra: "discard me too" },
      ],
      isError: false,
      timestamp: 1_000,
    };
    const errorResult = {
      role: "toolResult",
      toolCallId: "call-real-error",
      toolName: "read",
      content: [{ type: "text", text: "permission denied", extra: "discard me" }],
      isError: true,
      timestamp: 1_001,
    };

    await collect(
      commandCodeStream(
        { id: "Qwen/Qwen3.7-Flash" } as never,
        {
          messages: [success, errorResult],
        } as never,
        { apiKey: "test-key" } as never,
      ),
    );

    expect(
      JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string).params.messages,
    ).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-real-success",
            toolName: "read",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-real-error",
            toolName: "read",
            output: { type: "error-text", value: "permission denied" },
          },
        ],
      },
    ]);
  });

  it("keeps legacy synthetic tool-result output in the pinned shape", () => {
    const request = buildCommandCodeRequest(
      {
        modelId: "Qwen/Qwen3.7-Flash",
        messages: [
          {
            role: "toolResult",
            toolCallId: "call-real-error",
            toolName: "read",
            content: [{ type: "text", text: "permission denied" }],
            isError: true,
            timestamp: 1_001,
          },
        ],
        tools: [],
      },
      { apiKey: "test-key" },
    );

    expect(request.body.params.messages).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-real-error",
            toolName: "read",
            output: { type: "error-text", value: "permission denied" },
          },
        ],
      },
    ]);
  });

  it("maps data lines to text, reasoning, tool calls, usage, and a complete terminal message", async () => {
    const response = new Response(
      [
        `data: ${JSON.stringify({ type: "text-delta", delta: "hello" })}\r\n`,
        `data: ${JSON.stringify({ type: "reasoning-delta", delta: "check" })}\r\n`,
        `data: ${JSON.stringify({ type: "tool-call", toolCallId: "call-1", name: "read", arguments: "{}" })}\r\n`,
        `data: ${JSON.stringify({ type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 4, outputTokens: 2 } })}\r\n`,
        "data: [DONE]\r\n",
      ].join(""),
    );
    const events = await collect(mapCommandCodeResponse(response, "Qwen/Qwen3.7-Flash"));
    const done = events.at(-1);

    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("Expected done event");
    expect(done.message.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "hello" }),
    );
    expect(done.message.content).toContainEqual(
      expect.objectContaining({ type: "thinking", thinking: "check" }),
    );
    expect(done.message.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", id: "call-1" }),
    );
    expect(done.message.usage.input).toBe(4);
    expect(done.message.usage.output).toBe(2);
  });

  it("returns an error terminal event for EOF before finish-step", async () => {
    const events = await collect(
      mapCommandCodeResponse(
        new Response(`data: ${JSON.stringify({ type: "text-delta", delta: "partial" })}\n`),
        "Qwen/Qwen3.7-Flash",
      ),
    );
    expect(events.at(-1)?.type).toBe("error");
  });

  it("maps upstream errors to a complete Pi error event", async () => {
    const events = await collect(
      mapCommandCodeResponse(
        new Response(`data: ${JSON.stringify({ type: "error", message: "invalid request" })}\n`),
        "Qwen/Qwen3.7-Flash",
      ),
    );
    const error = events.at(-1);
    expect(error?.type).toBe("error");
    if (error?.type !== "error") throw new Error("Expected error event");
    expect(error.error).toEqual(
      expect.objectContaining({ role: "assistant", stopReason: "error" }),
    );
  });

  it("maps pinned tool-call event fields toolName and input", async () => {
    const events = await collect(
      mapCommandCodeResponse(
        new Response(
          [
            `data: ${JSON.stringify({ type: "tool-call", toolCallId: "call-2", toolName: "read", input: { path: "README.md" } })}\n`,
            `data: ${JSON.stringify({ type: "finish-step", finishReason: "tool-calls" })}\n`,
          ].join(""),
        ),
        "Qwen/Qwen3.7-Flash",
      ),
    );
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("Expected done event");
    expect(done.message.content).toContainEqual({
      type: "toolCall",
      id: "call-2",
      name: "read",
      arguments: { path: "README.md" },
    });
  });

  it("maps tool-input start, deltas, and end to the complete Pi tool-call lifecycle", async () => {
    const events = await collect(
      mapCommandCodeResponse(
        new Response(
          [
            `data: ${JSON.stringify({ type: "tool-input-start", toolCallId: "call-stream", toolName: "read" })}\n`,
            `data: ${JSON.stringify({ type: "tool-input-delta", toolCallId: "call-stream", delta: '{"path":' })}\n`,
            `data: ${JSON.stringify({ type: "tool-input-delta", toolCallId: "call-stream", delta: '"README.md"}' })}\n`,
            `data: ${JSON.stringify({ type: "tool-input-end", toolCallId: "call-stream", input: { path: "README.md" } })}\n`,
            `data: ${JSON.stringify({ type: "finish-step", finishReason: "tool-calls" })}\n`,
          ].join(""),
        ),
        "Qwen/Qwen3.7-Flash",
      ),
    );

    expect(
      events.map((event) => event.type).filter((type) => type.startsWith("toolcall_")),
    ).toEqual(["toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end"]);
    expect(
      events.filter((event) => event.type === "toolcall_delta").map((event) => event.delta),
    ).toEqual(['{"path":', '"README.md"}']);
    expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
      toolCall: {
        type: "toolCall",
        id: "call-stream",
        name: "read",
        arguments: { path: "README.md" },
      },
    });
  });

  it("does not expose upstream error event text", async () => {
    const events = await collect(
      mapCommandCodeResponse(
        new Response(
          `data: ${JSON.stringify({ type: "error", message: "secret upstream detail" })}\n`,
        ),
        "Qwen/Qwen3.7-Flash",
      ),
    );
    const error = events.at(-1);
    expect(error?.type).toBe("error");
    if (error?.type !== "error") throw new Error("Expected error event");
    expect(error.error.errorMessage).not.toContain("secret upstream detail");
  });

  it("does not expose HTTP response text in errors", async () => {
    const events = await collect(
      mapCommandCodeResponse(
        new Response("secret upstream detail", { status: 429 }),
        "Qwen/Qwen3.7-Flash",
      ),
    );
    const error = events.at(-1);
    expect(error?.type).toBe("error");
    if (error?.type !== "error") throw new Error("Expected error event");
    expect(error.error.errorMessage).toBe("Command Code request failed (429)");
    expect(error.error.errorMessage).not.toContain("secret upstream detail");
  });

  it("does not allow caller headers to spoof the provider or CLI identity", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(`data: ${JSON.stringify({ type: "finish-step", finishReason: "stop" })}\n`),
    );
    vi.stubGlobal("fetch", fetchMock);
    const stream = commandCodeStream(
      { id: "Qwen/Qwen3.7-Flash" } as never,
      { messages: [] } as never,
      {
        apiKey: "test-key",
        headers: {
          "x-project-slug": "opencode",
          "x-client-name": "OpenCode",
          "x-command-code-version": "0.0.0",
        },
      } as never,
    );
    await collect(stream);
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-project-slug"]).toBe("modus");
    expect(headers["x-client-name"]).toBe("Modus");
    expect(headers["x-command-code-version"]).toBe("modus-native-adapter/0.1.0");
  });
});
