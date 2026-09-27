import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCommandCodeRequest, mapCommandCodeResponse } from "./commandcode-adapter";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of stream) result.push(item);
  return result;
}

afterEach(() => vi.unstubAllGlobals());

describe("Command Code adapter", () => {
  it("preserves model ID and sends only supported conversation fields", () => {
    const request = buildCommandCodeRequest({
      modelId: "Qwen/Qwen3.7-Flash",
      systemPrompt: "Use tools when needed.",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      maxTokens: 4096,
    }, { apiKey: "user_test_secret", sessionId: "session-1" });

    expect(request.url).toBe("https://api.commandcode.ai/alpha/generate");
    expect(request.headers.Authorization).toBe("Bearer user_test_secret");
    expect(request.headers["x-project-slug"]).not.toBe("opencode");
    expect(request.body.params.model).toBe("Qwen/Qwen3.7-Flash");
    expect(request.body.params.stream).toBe(true);
    expect(request.body.params.tools).toEqual([
      { name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(request.body).not.toHaveProperty("memory.projectMemory");
    expect(request.body.params.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(request.body.config.systemPrompt).toBe("Use tools when needed.");
  });

  it("maps data lines to text, reasoning, tool calls, usage, and a complete terminal message", async () => {
    const response = new Response([
      `data: ${JSON.stringify({ type: "text-delta", delta: "hello" })}\r\n`,
      `data: ${JSON.stringify({ type: "reasoning-delta", delta: "check" })}\r\n`,
      `data: ${JSON.stringify({ type: "tool-call", toolCallId: "call-1", name: "read", arguments: "{}" })}\r\n`,
      `data: ${JSON.stringify({ type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 4, outputTokens: 2 } })}\r\n`,
      "data: [DONE]\r\n",
    ].join(""));
    const events = await collect(mapCommandCodeResponse(response, "Qwen/Qwen3.7-Flash"));
    const done = events.at(-1);

    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("Expected done event");
    expect(done.message.content).toContainEqual(expect.objectContaining({ type: "text", text: "hello" }));
    expect(done.message.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "check" }));
    expect(done.message.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "call-1" }));
    expect(done.message.usage.input).toBe(4);
    expect(done.message.usage.output).toBe(2);
  });

  it("returns an error terminal event for EOF before finish-step", async () => {
    const events = await collect(mapCommandCodeResponse(
      new Response(`data: ${JSON.stringify({ type: "text-delta", delta: "partial" })}\n`),
      "Qwen/Qwen3.7-Flash",
    ));
    expect(events.at(-1)?.type).toBe("error");
  });

  it("maps upstream errors to a complete Pi error event", async () => {
    const events = await collect(mapCommandCodeResponse(
      new Response(`data: ${JSON.stringify({ type: "error", message: "invalid request" })}\n`),
      "Qwen/Qwen3.7-Flash",
    ));
    const error = events.at(-1);
    expect(error?.type).toBe("error");
    if (error?.type !== "error") throw new Error("Expected error event");
    expect(error.error).toEqual(expect.objectContaining({ role: "assistant", stopReason: "error" }));
  });
});
