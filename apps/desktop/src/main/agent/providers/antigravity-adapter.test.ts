import { afterEach, describe, expect, it, vi } from "vitest";
import {
  antigravityStream,
  buildAntigravityRequest,
  createAntigravityStream,
  mapAntigravityResponse,
  setAntigravityCredentials,
} from "./antigravity-adapter";
import { antigravityModels } from "./antigravity-models";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

afterEach(() => {
  setAntigravityCredentials(null);
  vi.unstubAllGlobals();
});

describe("Antigravity adapter", () => {
  it("uses the source-faithful wire model names for all exact IDs and route styles", () => {
    const wireNames: Record<string, string> = {
      "antigravity-gemini-3-pro": "gemini-3-pro-low",
      "antigravity-gemini-3.1-pro": "gemini-3.1-pro-low",
      "antigravity-gemini-3-flash": "gemini-3-flash",
      "antigravity-claude-sonnet-4-6": "claude-sonnet-4-6",
      "antigravity-claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
      "gemini-2.5-flash": "gemini-2.5-flash",
      "gemini-2.5-pro": "gemini-2.5-pro",
      "gemini-3-flash-preview": "gemini-3-flash-preview",
      "gemini-3-pro-preview": "gemini-3-pro-preview",
      "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools": "gemini-3.1-pro-preview-customtools",
    };
    expect(antigravityModels.map(({ id }) => id).sort()).toEqual(Object.keys(wireNames).sort());

    for (const model of antigravityModels) {
      const projectId = `found-${model.quotaRoute}-project`;
      const request = buildAntigravityRequest(
        { modelId: model.id, messages: [], tools: [] },
        {
          accessToken: "secret",
          projectId,
        },
      );
      expect(request.route).toBe(model.quotaRoute);
      expect(request.url).toContain(
        model.quotaRoute === "antigravity"
          ? "daily-cloudcode-pa.sandbox.googleapis.com"
          : "cloudcode-pa.googleapis.com",
      );
      expect(request.url).toContain(`/v1internal:streamGenerateContent?alt=sse`);
      expect(request.headers.authorization).toBe("Bearer secret");
      expect(request.body).toMatchObject({ project: projectId, model: wireNames[model.id] });
      if (model.quotaRoute === "gemini-cli") {
        expect(request.body).not.toHaveProperty("requestType");
        expect(request.body).not.toHaveProperty("userAgent");
        expect(request.body).not.toHaveProperty("requestId");
      } else {
        expect(request.body).toMatchObject({ requestType: "agent", userAgent: "antigravity" });
        expect(request.body.requestId).toMatch(/^agent-[0-9a-f-]{36}$/);
      }
    }
  });

  it("routes Gemini 3 Pro high selections to high wire model IDs without changing routes", () => {
    const cases = [
      ["antigravity-gemini-3-pro", "gemini-3-pro-low", "gemini-3-pro-high"],
      ["antigravity-gemini-3.1-pro", "gemini-3.1-pro-low", "gemini-3.1-pro-high"],
    ] as const;
    for (const [modelId, lowId, highId] of cases) {
      const low = buildAntigravityRequest(
        { modelId, messages: [], tools: [], thinkingLevel: "low" },
        { accessToken: "secret", projectId: null },
      );
      const high = buildAntigravityRequest(
        { modelId, messages: [], tools: [], thinkingLevel: "high" },
        { accessToken: "secret", projectId: null },
      );
      const bare = buildAntigravityRequest(
        { modelId, messages: [], tools: [] },
        { accessToken: "secret", projectId: null },
      );
      expect([low.body.model, high.body.model, bare.body.model]).toEqual([lowId, highId, lowId]);
      expect(low.route).toBe("antigravity");
      expect(high.route).toBe("antigravity");
      expect(bare.route).toBe("antigravity");
    }
  });

  it("requires an actually discovered project for exact Gemini CLI IDs", () => {
    expect(() =>
      buildAntigravityRequest(
        { modelId: "gemini-2.5-pro", messages: [], tools: [] },
        {
          accessToken: "secret",
          projectId: null,
        },
      ),
    ).toThrow(/project/i);
    expect(() =>
      buildAntigravityRequest(
        { modelId: "GEMINI-2.5-PRO", messages: [], tools: [] },
        {
          accessToken: "secret",
          projectId: "found-project",
        },
      ),
    ).toThrow(/unsupported/i);
  });

  it("builds authenticated truthful envelopes and normalizes Gemini and Claude requests", () => {
    const gemini = buildAntigravityRequest(
      {
        modelId: "antigravity-gemini-3-pro",
        systemPrompt: "system",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image", data: "ignored" },
            ],
          },
        ],
        tools: [
          {
            name: "lookup",
            description: "Look up",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
        thinkingLevel: "high",
        maxTokens: 1000,
      },
      { accessToken: "secret", projectId: null },
    );
    expect(gemini.headers).toMatchObject({ authorization: "Bearer secret", "user-agent": "Modus" });
    expect(gemini.headers).not.toHaveProperty("x-api-key");
    expect(gemini.headers).not.toHaveProperty("x-goog-user-project");
    expect(gemini.body.request).toMatchObject({
      systemInstruction: { parts: [{ text: "system" }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: "lookup",
              description: "Look up",
              parameters: { type: "OBJECT", properties: { q: { type: "STRING" } } },
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 1000, thinkingConfig: { thinkingLevel: "high" } },
    });

    const claude = buildAntigravityRequest(
      {
        modelId: "antigravity-claude-opus-4-6-thinking",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} } }],
        thinkingBudget: 8192,
      },
      { accessToken: "secret", projectId: null },
    );
    expect(claude.body.request).toMatchObject({
      toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
      generationConfig: {
        maxOutputTokens: 64000,
        thinkingConfig: { include_thoughts: true, thinking_budget: 8192 },
      },
    });
  });

  it("maps Claude Opus max reasoning to the pinned budget and output limits", () => {
    const request = buildAntigravityRequest(
      {
        modelId: "antigravity-claude-opus-4-6-thinking",
        messages: [],
        tools: [],
        thinkingLevel: "max",
      },
      { accessToken: "secret", projectId: null },
    );
    expect(request.body.request).toMatchObject({
      generationConfig: {
        maxOutputTokens: 64000,
        thinkingConfig: { include_thoughts: true, thinking_budget: 32768 },
      },
    });
  });

  it("sends each supported Antigravity Gemini reasoning level exactly as selected", () => {
    const choices: Array<[string, string[]]> = [
      ["antigravity-gemini-3-pro", ["low", "high"]],
      ["antigravity-gemini-3.1-pro", ["low", "high"]],
      ["antigravity-gemini-3-flash", ["minimal", "low", "medium", "high"]],
    ];

    for (const [modelId, levels] of choices) {
      for (const level of levels) {
        const request = buildAntigravityRequest(
          { modelId, messages: [], tools: [], thinkingLevel: level },
          {
            accessToken: "secret",
            projectId: null,
          },
        );
        expect(request.body.request).toMatchObject({
          generationConfig: { thinkingConfig: { thinkingLevel: level } },
        });
      }
    }
  });

  it("maps Opus low and high Pi reasoning budgets to exact request budgets", () => {
    for (const thinkingBudget of [8192, 32768]) {
      const request = buildAntigravityRequest(
        {
          modelId: "antigravity-claude-opus-4-6-thinking",
          messages: [],
          tools: [],
          thinkingLevel: "high",
          thinkingBudget,
        },
        { accessToken: "secret", projectId: null },
      );
      expect(request.body.request).toMatchObject({
        generationConfig: {
          thinkingConfig: { include_thoughts: true, thinking_budget: thinkingBudget },
        },
      });
    }
  });

  it("does not send thinking configuration for Claude Sonnet", () => {
    const request = buildAntigravityRequest(
      {
        modelId: "antigravity-claude-sonnet-4-6",
        messages: [],
        tools: [],
        thinkingLevel: "high",
        thinkingBudget: 8192,
      },
      { accessToken: "secret", projectId: null },
    );
    expect(request.body.request).not.toHaveProperty("generationConfig.thinkingConfig");
  });

  it("omits thinking configuration for bare Gemini CLI provider defaults", () => {
    const modelIds = [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ];
    for (const modelId of modelIds) {
      const request = buildAntigravityRequest(
        { modelId, messages: [], tools: [], thinkingLevel: "off" },
        {
          accessToken: "secret",
          projectId: "found-project",
        },
      );
      const generationConfig = request.body.request.generationConfig as Record<string, unknown>;
      expect(generationConfig).not.toHaveProperty("thinkingConfig");
      expect(JSON.stringify(request.body)).not.toContain('"thinkingLevel":"OFF"');
      expect(JSON.stringify(request.body)).not.toContain("thinking_budget");
    }
  });

  it("omits thinkingConfig on a real Gemini 3 CLI run when Pi reasoning is off", async () => {
    let sentBody: Record<string, any> | undefined;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}\n\n`,
      );
    });
    await collect(
      createAntigravityStream({
        credentials: () => ({ accessToken: "secret", projectId: "found-project" }),
        fetch: fetcher as typeof fetch,
      })(
        { id: "gemini-3-pro-preview" } as never,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] } as never,
        { reasoning: "off" } as never,
      ),
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(sentBody?.model).toBe("gemini-3-pro-preview");
    expect(sentBody?.request.generationConfig).not.toHaveProperty("thinkingConfig");
  });

  it("round-trips a response Gemini thinking signature on a subsequent turn", async () => {
    const firstTurn = await collect(
      mapAntigravityResponse(
        new Response(
          `data: ${JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { thought: true, text: "reasoning", thoughtSignature: "returned-signature" },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          })}\n\n`,
        ),
        "antigravity-gemini-3-pro",
      ),
    );
    const response = firstTurn.at(-1);
    if (response?.type !== "done") throw new Error("expected a complete first turn");

    const nextTurn = buildAntigravityRequest(
      {
        modelId: "antigravity-gemini-3-pro",
        messages: [
          {
            role: "assistant",
            provider: "antigravity",
            model: "antigravity-gemini-3-pro",
            content: response.message.content,
          },
        ],
        tools: [],
      },
      { accessToken: "secret", projectId: null },
    );

    expect(nextTurn.body.request).toMatchObject({
      contents: [
        {
          role: "model",
          parts: [{ text: "reasoning", thought: true, thoughtSignature: "returned-signature" }],
        },
      ],
    });
  });

  it("preserves ordinary text thought signatures and replays all signature types for the same Antigravity model", async () => {
    const firstTurn = await collect(
      mapAntigravityResponse(
        new Response(
          `data: ${JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: "answer", thoughtSignature: "text-signature" }] },
                finishReason: "STOP",
              },
            ],
          })}\n\n`,
        ),
        "antigravity-gemini-3-pro",
      ),
    );
    const response = firstTurn.at(-1);
    if (response?.type !== "done") throw new Error("expected a complete first turn");
    expect(response.message.content).toContainEqual({
      type: "text",
      text: "answer",
      textSignature: "text-signature",
    });

    let sentBody: Record<string, any> | undefined;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}\n\n`,
      );
    });
    await collect(
      createAntigravityStream({
        credentials: () => ({ accessToken: "secret", projectId: null }),
        fetch: fetcher as typeof fetch,
      })(
        { id: "antigravity-gemini-3-pro" } as never,
        {
          messages: [
            {
              role: "assistant",
              provider: "antigravity",
              model: "antigravity-gemini-3-pro",
              content: [
                ...response.message.content,
                { type: "thinking", thinking: "reason", thinkingSignature: "thinking-signature" },
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "lookup",
                  arguments: { q: "x" },
                  thoughtSignature: "tool-signature",
                },
              ],
              timestamp: 1,
            },
          ],
          tools: [],
        } as never,
      ),
    );

    expect(sentBody?.request.contents[0].parts).toEqual([
      { text: "answer", thoughtSignature: "text-signature" },
      { text: "reason", thought: true, thoughtSignature: "thinking-signature" },
      {
        functionCall: { id: "call-1", name: "lookup", args: { q: "x" } },
        thoughtSignature: "tool-signature",
      },
    ]);
  });

  it.each([
    ["other provider", "other-provider", "antigravity-gemini-3-pro"],
    ["different model", "antigravity", "antigravity-gemini-3.1-pro"],
  ])("does not replay signatures from an assistant message with %s origin", async (_description, provider, sourceModel) => {
    let sentBody: Record<string, any> | undefined;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}\n\n`,
      );
    });
    await collect(
      createAntigravityStream({
        credentials: () => ({ accessToken: "secret", projectId: null }),
        fetch: fetcher as typeof fetch,
      })(
        { id: "antigravity-gemini-3-pro" } as never,
        {
          messages: [
            {
              role: "assistant",
              provider,
              model: sourceModel,
              content: [
                { type: "text", text: "answer", textSignature: "text-signature" },
                { type: "thinking", thinking: "reason", thinkingSignature: "thinking-signature" },
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "lookup",
                  arguments: { q: "x" },
                  thoughtSignature: "tool-signature",
                },
              ],
              timestamp: 1,
            },
          ],
          tools: [],
        } as never,
      ),
    );

    expect(sentBody?.request.contents[0].parts).toEqual([
      { text: "answer" },
      { text: "reason", thought: true },
      { functionCall: { id: "call-1", name: "lookup", args: { q: "x" } } },
    ]);
  });

  it("maps actual Pi tool results through antigravityStream into unverified functionResponse parts", async () => {
    let sentBody: Record<string, any> | undefined;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}\n\n`,
      );
    });
    vi.stubGlobal("fetch", fetcher);
    setAntigravityCredentials({ accessToken: "secret", projectId: null });

    await collect(
      antigravityStream(
        { id: "antigravity-gemini-3-pro" } as never,
        {
          messages: [
            {
              role: "toolResult",
              toolCallId: "call-success",
              toolName: "lookup",
              content: [{ type: "text", text: "found it" }],
              isError: false,
              timestamp: 1,
            },
            {
              role: "toolResult",
              toolCallId: "call-error",
              toolName: "lookup",
              content: [{ type: "text", text: "Lookup failed safely" }],
              isError: true,
              timestamp: 2,
            },
          ],
          tools: [],
        } as never,
      ),
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sentBody?.request.contents).toEqual([
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "lookup",
              id: "call-success",
              response: { result: "found it" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "lookup",
              id: "call-error",
              response: { result: "Lookup failed safely" },
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(sentBody)).not.toContain("isError");
  });

  it("normalizes JSON and SSE responses with text, thoughts, signatures, tools, usage and finish", async () => {
    const response = new Response(
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: "answer" },
                { thought: true, text: "reason", thoughtSignature: "gem-sign" },
                {
                  functionCall: { id: "c1", name: "lookup", args: { q: "x" } },
                  thoughtSignature: "tool-sign",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      })}\n\n`,
    );
    const events = await collect(mapAntigravityResponse(response, "antigravity-gemini-3-pro"));
    expect(events.at(-1)?.type).toBe("done");
    const finalEvent = events.at(-1);
    if (finalEvent?.type !== "done") throw new Error("expected done");
    expect(finalEvent.message.content).toContainEqual(
      expect.objectContaining({
        type: "thinking",
        thinking: "reason",
        thinkingSignature: "gem-sign",
      }),
    );
    expect(finalEvent.message.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", id: "c1", thoughtSignature: "tool-sign" }),
    );
    expect(finalEvent.message.usage).toMatchObject({ input: 3, output: 2 });
  });

  it("unwraps pinned response envelopes and emits incremental text, thought, and tool deltas", async () => {
    const sourceEvents = [
      {
        response: { candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
        traceId: "trace-1",
      },
      {
        response: {
          candidates: [
            {
              content: {
                parts: [{ text: "checking", thought: true, thoughtSignature: "sig-thought" }],
              },
            },
          ],
        },
        traceId: "trace-1",
      },
      {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: "call-9", name: "lookup", args: { q: "x" } },
                    thoughtSignature: "sig-call",
                  },
                ],
              },
            },
          ],
        },
        traceId: "trace-1",
      },
      {
        response: {
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 },
        },
        traceId: "trace-1",
      },
    ];
    const body = sourceEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const events = await collect(
      mapAntigravityResponse(new Response(body), "antigravity-gemini-3-pro"),
    );

    expect(events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "text_delta",
        "thinking_delta",
        "toolcall_start",
        "toolcall_delta",
        "done",
      ]),
    );
    const textDelta = events.find((event) => event.type === "text_delta");
    expect(textDelta).toMatchObject({ delta: "Hello" });
    const thinkingDelta = events.find((event) => event.type === "thinking_delta");
    expect(thinkingDelta).toMatchObject({ delta: "checking" });
    const toolDelta = events.find((event) => event.type === "toolcall_delta");
    expect(toolDelta).toMatchObject({ delta: JSON.stringify({ q: "x" }) });
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      type: "done",
      message: { usage: { input: 7, output: 4, totalTokens: 11 } },
    });
    if (terminal?.type !== "done") throw new Error("expected complete terminal message");
    expect(terminal.message.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "Hello" }),
    );
    expect(terminal.message.content).toContainEqual(
      expect.objectContaining({
        type: "thinking",
        thinking: "checking",
        thinkingSignature: "sig-thought",
      }),
    );
    expect(terminal.message.content).toContainEqual(
      expect.objectContaining({
        type: "toolCall",
        id: "call-9",
        name: "lookup",
        arguments: { q: "x" },
        thoughtSignature: "sig-call",
      }),
    );
  });

  it("unwraps pinned non-streaming JSON response envelopes", async () => {
    const pinnedResponse = {
      response: {
        candidates: [{ content: { parts: [{ text: "json answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
      },
      traceId: "trace-json",
    };
    const response = new Response(JSON.stringify(pinnedResponse), {
      headers: { "content-type": "application/json" },
    });
    const events = await collect(mapAntigravityResponse(response, "gemini-2.5-pro"));
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text: "json answer" }], usage: { input: 2, output: 3 } },
    });
  });

  it("does not retry other quota pools and sanitizes HTTP failures", async () => {
    const fetcher = vi.fn(async () => new Response("secret body", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    const events = await collect(
      createAntigravityStream({ credentials: () => ({ accessToken: "secret", projectId: null }) })(
        { id: "antigravity-gemini-3-pro" } as never,
        { messages: [], tools: [] } as never,
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("error");
    expect(JSON.stringify(events.at(-1))).not.toContain("secret");
    expect(JSON.stringify(events.at(-1))).not.toContain("secret body");
  });

  it("returns errors for malformed or incomplete streams and honors abort", async () => {
    expect(
      (await collect(mapAntigravityResponse(new Response("data: nope\n\n"), "gemini-2.5-pro"))).at(
        -1,
      )?.type,
    ).toBe("error");
    expect(
      (await collect(mapAntigravityResponse(new Response("data: {}\n\n"), "gemini-2.5-pro"))).at(-1)
        ?.type,
    ).toBe("error");
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const events = await collect(
      createAntigravityStream({ credentials: () => ({ accessToken: "secret", projectId: null }) })(
        { id: "antigravity-gemini-3-pro" } as never,
        { messages: [], tools: [] } as never,
        { signal: controller.signal } as never,
      ),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("error");
  });
});
