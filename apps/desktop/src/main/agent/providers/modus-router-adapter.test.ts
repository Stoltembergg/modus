import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBackend, createFakeSafeStorage } from "../../auth/auth.test-helpers";
import { AuthBackendError } from "../../auth/auth-backend";
import { createAuthService } from "../../auth/auth-service";
import { createAuthSessionStore } from "../../auth/auth-session-store";
import { createOAuthFlowRegistry } from "../../auth/oauth-flow";
import {
  buildModusRequestBody,
  createModusRouterStream,
  MODUS_API_ID,
  type ModusRouterDeps,
  type ModusSession,
  modusErrorKey,
  routerModelId,
} from "./modus-router-adapter";

const ROUTER = "https://crdgtmyvwdnswuggpjco.supabase.co/functions/v1/model-router";
const TOKEN = "jwt-SECRET-old";
const NEW_TOKEN = "jwt-SECRET-new";
const PROMPT = "PRIVATE-PROMPT-tell me a secret";
const REPLY = "PRIVATE-REPLY-the answer";

function model(id = "modus/deepseek/deepseek-flash", overrides: Partial<Model<Api>> = {}) {
  return {
    id,
    name: "DeepSeek Flash",
    api: MODUS_API_ID,
    provider: "modus",
    baseUrl: "https://evil.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...overrides,
  } as Model<Api>;
}

const context: Context = {
  systemPrompt: "be brief",
  messages: [{ role: "user", content: PROMPT, timestamp: 1 }],
};

function sse(chunks: unknown[], { finish = true }: { finish?: boolean } = {}): Response {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  if (finish) lines.push("data: [DONE]\n\n");
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const OK_CHUNKS = [
  { id: "c1", model: "deepseek/deepseek-flash", choices: [{ delta: { reasoning_content: "hm" } }] },
  { id: "c1", choices: [{ delta: { content: REPLY } }] },
  { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
  { id: "c1", choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
];

const errorResponse = (status: number, code?: string) =>
  new Response(code ? JSON.stringify({ error: code }) : "", { status });

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function fakeFetch(respond: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    calls.push(call);
    return await respond(call, calls.length - 1);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function fakeSession(overrides: Partial<ModusSession> = {}) {
  return {
    getAccessToken: vi.fn(async () => TOKEN as string | null),
    refreshAccessToken: vi.fn(async (_rejected: string) => NEW_TOKEN),
    expireSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function run(deps: Partial<ModusRouterDeps> & Pick<ModusRouterDeps, "session">, m = model()) {
  let n = 0;
  const stream = createModusRouterStream({
    routerUrl: () => ROUTER,
    anonKey: () => "sb_publishable_test",
    newIdempotencyKey: () => `key-${++n}-${Math.random().toString(36).slice(2)}`,
    ...deps,
  })(m, context, {
    apiKey: "modus-session",
    headers: { authorization: "Bearer evil", "x-evil": "1" },
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const last = events.at(-1);
  return { events, last };
}

function terminalMessage(event: AssistantMessageEvent | undefined) {
  if (!event) throw new Error("no event");
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  throw new Error(`not terminal: ${event.type}`);
}

describe("routerModelId (decision 8)", () => {
  it("strips the modus/ prefix and keeps the router's <provider>/<id>", () => {
    expect(routerModelId("modus/deepseek/deepseek-flash")).toBe("deepseek/deepseek-flash");
    expect(routerModelId("deepseek/deepseek-flash")).toBe("deepseek/deepseek-flash");
    expect(routerModelId("zai/glm-4.6")).toBe("zai/glm-4.6");
  });

  it("sends only the Modus model id in the body", async () => {
    const { fn, calls } = fakeFetch(() => sse(OK_CHUNKS));
    await run({ session: fakeSession(), fetch: fn });
    await run({ session: fakeSession(), fetch: fn }, model("deepseek/deepseek-flash"));
    expect(calls.map((call) => call.body.model)).toEqual([
      "deepseek/deepseek-flash",
      "deepseek/deepseek-flash",
    ]);
  });
});

describe("modus router stream", () => {
  it("streams text, reasoning and the final usage chunk from the fixed URL with the session token", async () => {
    const { fn, calls } = fakeFetch(() => sse(OK_CHUNKS));
    const onCallSettled = vi.fn();
    const { events, last } = await run({ session: fakeSession(), fetch: fn, onCallSettled });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    // Fixed URL: model.baseUrl (evil.example.com) and options.headers are ignored.
    expect(call?.url).toBe(`${ROUTER}/v1/chat/completions`);
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers["x-evil"]).toBeUndefined();
    expect(call?.headers["idempotency-key"]).toMatch(/^key-1-/);
    expect(call?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    const message = terminalMessage(last);
    expect(message.content).toEqual([
      { type: "thinking", thinking: "hm" },
      { type: "text", text: REPLY },
    ]);
    expect(message.usage).toMatchObject({ input: 12, output: 5, totalTokens: 17 });
    expect(message.model).toBe("modus/deepseek/deepseek-flash");
    expect(onCallSettled).toHaveBeenCalledTimes(1);
  });

  it("maps streamed tool calls (by index) to a toolUse stop", async () => {
    const { fn } = fakeFetch(() =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    const { events, last } = await run({ session: fakeSession(), fetch: fn });
    expect(last?.type).toBe("done");
    const end = events.find((event) => event.type === "toolcall_end");
    expect(end && end.type === "toolcall_end" ? end.toolCall : undefined).toEqual({
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: { path: "a" },
    });
    expect(terminalMessage(last).stopReason).toBe("toolUse");
  });

  it("builds an OpenAI body from the pi context (tools, max_tokens) without reasoning knobs", () => {
    const body = buildModusRequestBody(
      model(),
      {
        ...context,
        tools: [{ name: "read", description: "Read", parameters: { type: "object" } as never }],
      },
      { maxTokens: 512 },
    );
    expect(body).toMatchObject({
      model: "deepseek/deepseek-flash",
      max_tokens: 512,
      tools: [{ type: "function", function: { name: "read", description: "Read" } }],
    });
    expect(JSON.stringify(body.messages)).toContain(PROMPT);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("store");
  });

  it("without a session it does not call the router", async () => {
    const { fn, calls } = fakeFetch(() => sse(OK_CHUNKS));
    const { last } = await run({
      session: fakeSession({ getAccessToken: vi.fn(async () => null) }),
      fetch: fn,
    });
    expect(calls).toHaveLength(0);
    expect(terminalMessage(last).errorMessage).toBe(
      "Sign in to your Modus account to use Modus models.",
    );
  });

  it("without a router URL it does not call anything", async () => {
    const { fn, calls } = fakeFetch(() => sse(OK_CHUNKS));
    const { last } = await run({ session: fakeSession(), fetch: fn, routerUrl: () => undefined });
    expect(calls).toHaveLength(0);
    expect(terminalMessage(last).errorMessage).toMatch(/temporarily unavailable/);
  });
});

describe("401: refresh once, retry once (same Idempotency-Key)", () => {
  it("same key after 401: one refresh, one retry with the new token and the SAME key", async () => {
    const { fn, calls } = fakeFetch((call) =>
      call.headers.authorization === `Bearer ${TOKEN}` ? errorResponse(401) : sse(OK_CHUNKS),
    );
    const session = fakeSession();
    const { last } = await run({ session, fetch: fn });
    expect(last?.type).toBe("done");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${NEW_TOKEN}`);
    expect(calls[1]?.headers["idempotency-key"]).toBe(calls[0]?.headers["idempotency-key"]);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(session.refreshAccessToken).toHaveBeenCalledWith(TOKEN);
    expect(session.expireSession).not.toHaveBeenCalled();
  });

  it("a second 401 after the retry expires the session (no third request)", async () => {
    const { fn, calls } = fakeFetch(() => errorResponse(401, "unauthorized"));
    const session = fakeSession();
    const onCallSettled = vi.fn();
    const { last } = await run({ session, fetch: fn, onCallSettled });
    expect(calls).toHaveLength(2);
    expect(session.expireSession).toHaveBeenCalledTimes(1);
    expect(terminalMessage(last).errorMessage).toBe("Your session expired. Please sign in again.");
    expect(onCallSettled).not.toHaveBeenCalled();
  });

  it("a rejected refresh expires the session without retrying", async () => {
    const { fn, calls } = fakeFetch(() => errorResponse(401));
    const session = fakeSession({
      refreshAccessToken: vi.fn(async () => {
        throw new AuthBackendError("rejected", "Invalid Refresh Token");
      }),
    });
    const { last } = await run({ session, fetch: fn });
    expect(calls).toHaveLength(1);
    expect(session.expireSession).toHaveBeenCalledTimes(1);
    expect(terminalMessage(last).errorMessage).toBe("Your session expired. Please sign in again.");
  });

  it("a refresh that fails on the network keeps the session", async () => {
    const { fn, calls } = fakeFetch(() => errorResponse(401));
    const session = fakeSession({
      refreshAccessToken: vi.fn(async () => {
        throw new AuthBackendError("network", "network");
      }),
    });
    const { last } = await run({ session, fetch: fn });
    expect(calls).toHaveLength(1);
    expect(session.expireSession).not.toHaveBeenCalled();
    expect(terminalMessage(last).errorMessage).toMatch(/Couldn't reach Modus/);
  });

  it("single-flight (Debbie): 3 concurrent 401s → exactly 1 refreshSession, 3 retries with the new token and their own keys, no sign-out", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "modus-b4b-single-flight-"));
    try {
      const fake = createFakeBackend();
      let current = TOKEN;
      fake.backend.signInWithPassword.mockResolvedValue({
        accessToken: TOKEN,
        refreshToken: "refresh-SECRET",
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "ana@example.com",
          emailConfirmedAt: null,
          provider: "email",
          metadata: {},
        },
      });
      fake.backend.getAccessToken.mockImplementation(async () => current);
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      fake.backend.refreshAccessToken.mockImplementation(async () => {
        await gate;
        current = NEW_TOKEN;
        return NEW_TOKEN;
      });
      const service = createAuthService({
        config: {
          supabaseUrl: "https://crdgtmyvwdnswuggpjco.supabase.co",
          anonKey: "sb_publishable_test",
          oauthProviders: [],
        },
        backend: fake.backend,
        store: createAuthSessionStore({
          userDataPath,
          safeStorage: createFakeSafeStorage(),
          platform: "linux",
        }),
        flows: createOAuthFlowRegistry(),
        startLoopback: vi.fn(),
        openExternal: vi.fn(),
      });
      await service.initialize();
      await service.signInWithPassword({ email: "ana@example.com", password: "correct horse" });
      expect(service.getState().status).toBe("signed-in");

      let unauthorized = 0;
      const { fn, calls } = fakeFetch((call) => {
        if (call.headers.authorization === `Bearer ${TOKEN}`) {
          unauthorized += 1;
          if (unauthorized === 3) setTimeout(() => release?.(), 0);
          return errorResponse(401);
        }
        return sse(OK_CHUNKS);
      });
      const session: ModusSession = {
        getAccessToken: () => service.getAccessToken(),
        refreshAccessToken: (rejected) => service.refreshAccessToken(rejected),
        expireSession: () => service.expireSession(),
      };
      const results = await Promise.all([
        run({ session, fetch: fn }),
        run({ session, fetch: fn }),
        run({ session, fetch: fn }),
      ]);
      expect(results.map((result) => result.last?.type)).toEqual(["done", "done", "done"]);
      expect(fake.backend.refreshAccessToken).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(6);
      const first = calls.filter((call) => call.headers.authorization === `Bearer ${TOKEN}`);
      const retries = calls.filter((call) => call.headers.authorization === `Bearer ${NEW_TOKEN}`);
      expect(first).toHaveLength(3);
      expect(retries).toHaveLength(3);
      const firstKeys = first.map((call) => call.headers["idempotency-key"]).sort();
      const retryKeys = retries.map((call) => call.headers["idempotency-key"]).sort();
      expect(new Set(firstKeys).size).toBe(3);
      expect(retryKeys).toEqual(firstKeys);
      expect(fake.backend.signOut).not.toHaveBeenCalled();
      expect(service.getState()).toMatchObject({ status: "signed-in", notice: null });
      await service.shutdown();
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});

describe("new Idempotency-Key otherwise, never an automatic retry", () => {
  it("402 / 503 / 504 / network error / mid-stream failure / user resend each use a new key and one request", async () => {
    const outcomes: Array<() => Response | Promise<Response>> = [
      () => errorResponse(402, "insufficient_credits"),
      () => errorResponse(503, "provider_not_configured"),
      () => errorResponse(504, "upstream_timeout"),
      () => {
        throw new TypeError("fetch failed");
      },
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\n`,
                ),
              );
              controller.error(new Error("socket hang up"));
            },
          }),
          { status: 200 },
        ),
      () => sse(OK_CHUNKS),
      () => sse(OK_CHUNKS),
    ];
    let index = 0;
    const { fn, calls } = fakeFetch(() => {
      const next = outcomes[index];
      index += 1;
      if (!next) throw new Error("unexpected extra request");
      return next();
    });
    const messages: Array<string | undefined> = [];
    for (let i = 0; i < outcomes.length; i++) {
      const { last } = await run({ session: fakeSession(), fetch: fn });
      messages.push(terminalMessage(last).errorMessage);
    }
    expect(calls).toHaveLength(outcomes.length);
    const keys = calls.map((call) => call.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(messages).toEqual([
      "You're out of credits. Add credits or upgrade your plan in Settings › Account.",
      "Modus models are temporarily unavailable. Try again shortly.",
      "The model took too long to respond. Some credits may have been used.",
      "Couldn't reach Modus. Check your connection and try again.",
      "Couldn't reach Modus. Check your connection and try again.",
      undefined,
      undefined,
    ]);
  });

  it("a 409 tells the user the request was already processed", async () => {
    const { fn } = fakeFetch(() => errorResponse(409, "idempotency_replay"));
    const { last } = await run({ session: fakeSession(), fetch: fn });
    expect(terminalMessage(last).errorMessage).toBe("This request was already processed.");
  });

  it("maps router codes to the catalog (en)", () => {
    expect(modusErrorKey(402, "insufficient_credits")).toBe("modus.insufficientCredits");
    expect(modusErrorKey(403, "model_not_in_plan")).toBe("modus.modelNotInPlan");
    expect(modusErrorKey(404, "model_not_found")).toBe("modus.modelNotFound");
    expect(modusErrorKey(409, "idempotency_conflict")).toBe("modus.alreadyProcessed");
    expect(modusErrorKey(429, "too_many_requests")).toBe("modus.rateLimited");
    expect(modusErrorKey(503, "billing_unavailable")).toBe("modus.unavailable");
    expect(modusErrorKey(503, "pricing_not_configured")).toBe("modus.unavailable");
    expect(modusErrorKey(504, "upstream_timeout")).toBe("modus.timeout");
    expect(modusErrorKey(502, "upstream_error")).toBe("modus.upstreamError");
    expect(modusErrorKey(413, undefined)).toBe("modus.requestTooLarge");
    expect(modusErrorKey(400, "invalid_json")).toBe("modus.badRequest");
  });

  it("uses pt copy when the locale is pt", async () => {
    const { fn } = fakeFetch(() => errorResponse(504, "upstream_timeout"));
    const { last } = await run({ session: fakeSession(), fetch: fn, locale: () => "pt-BR" });
    expect(terminalMessage(last).errorMessage).toBe(
      "O modelo demorou demais para responder. Alguns créditos podem ter sido usados.",
    );
  });

  it("a user abort ends as aborted without another request", async () => {
    const controller = new AbortController();
    const { fn, calls } = fakeFetch(
      (_call) =>
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const stream = createModusRouterStream({
      routerUrl: () => ROUTER,
      session: fakeSession(),
      fetch: fn,
    })(model(), context, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });
});

describe("logs (review point 5)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never logs the token, the prompt or the response, on success or failure", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(
          args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
        );
      });
    }
    const outcomes = [
      () => sse(OK_CHUNKS),
      () => errorResponse(401),
      () => sse(OK_CHUNKS),
      () => errorResponse(402, "insufficient_credits"),
      () => {
        throw new TypeError(`fetch failed ${TOKEN}`);
      },
    ];
    let index = 0;
    const { fn } = fakeFetch(() => outcomes[index++]?.() ?? errorResponse(500));
    const messages: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { last } = await run({ session: fakeSession(), fetch: fn });
      messages.push(terminalMessage(last).errorMessage ?? "");
    }
    const everything = [...logged, ...messages].join("\n");
    for (const secret of [TOKEN, NEW_TOKEN, PROMPT, REPLY, "sb_publishable_test"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
