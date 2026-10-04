import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, parseStreamingJson } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { type ModusTextKey, modusText } from "../../../shared/modus-text";

/**
 * Modus provider (B4b): chat completions through the model-router Edge Function.
 *
 * - The access token comes from the main-process auth service on every request (`session`);
 *   `options.apiKey` is only the registry placeholder and is ignored, as are `model.baseUrl`
 *   and `options.headers` (the URL is fixed, see auth/router-config.ts).
 * - Own `fetch` (the status is known before any stream event) + a minimal OpenAI SSE parser:
 *   pi-ai's openai-completions stream builds its own OpenAI SDK client with no fetch hook and
 *   only exposes the HTTP status inside a formatted error string.
 * - Idempotency-Key: a new uuid per call. The SAME key is reused only for the single retry
 *   after a 401 (the router checks the JWT before it claims the key, handler.ts 668-669 vs
 *   255-256). No other retry: 402/429/5xx, a network error before or during the stream and a
 *   user resend all mean a new call, hence a new key. No SDK, so no hidden SDK retries.
 * - Never logs: no token, prompt, response or error body leaves this module except the
 *   catalog message chosen from the status / error code.
 */

export const MODUS_PROVIDER_ID = "modus";
export const MODUS_PROVIDER_NAME = "Modus";
export const MODUS_API_ID = "modus-router";
/** Not a credential: the registry needs an apiKey value to list the provider as available. */
export const MODUS_API_KEY_PLACEHOLDER = "modus-session";
/** Router cap is 120 s and the Edge runtime wall clock 150 s; give the client some margin. */
export const MODUS_REQUEST_TIMEOUT_MS = 170_000;
const ERROR_BODY_LIMIT = 4096;

export type ModusSession = {
  getAccessToken(): Promise<string | null>;
  /** Single-flight refresh (auth service); throws with `kind: "network"` when offline. */
  refreshAccessToken(rejected: string): Promise<string>;
  expireSession(): Promise<unknown>;
};

export type ModusRouterDeps = {
  /** The fixed router URL (…/functions/v1/model-router), undefined when not configured. */
  routerUrl(): string | undefined;
  /** Public project key sent as `apikey` (same as supabase-js functions.invoke). */
  anonKey?(): string | undefined;
  session: ModusSession;
  /** Called after every call that reached the router (Account balance refresh). */
  onCallSettled?(): void;
  fetch?: typeof fetch;
  newIdempotencyKey?(): string;
  locale?(): string | null | undefined;
  timeoutMs?: number;
};

/** pi registry ids are `modus/<provider>/<id>`; the router only knows `<provider>/<id>`. */
export function routerModelId(modelId: string): string {
  return modelId.startsWith(`${MODUS_PROVIDER_ID}/`)
    ? modelId.slice(MODUS_PROVIDER_ID.length + 1)
    : modelId;
}

/** Catalog key for a router error (`{"error": code}`), by code first, then status. */
export function modusErrorKey(status: number, code: string | undefined): ModusTextKey {
  switch (code) {
    case "insufficient_credits":
      return "modus.insufficientCredits";
    case "model_not_in_plan":
      return "modus.modelNotInPlan";
    case "model_not_found":
      return "modus.modelNotFound";
    case "idempotency_replay":
    case "idempotency_conflict":
      return "modus.alreadyProcessed";
    case "too_many_requests":
      return "modus.rateLimited";
    case "upstream_timeout":
      return "modus.timeout";
    case "upstream_error":
      return "modus.upstreamError";
    case "body_too_large":
    case "context_length_exceeded":
      return "modus.requestTooLarge";
  }
  if (status === 401) return "modus.sessionExpired";
  if (status === 402) return "modus.insufficientCredits";
  if (status === 403) return "modus.modelNotInPlan";
  if (status === 404) return "modus.modelNotFound";
  if (status === 409) return "modus.alreadyProcessed";
  if (status === 413) return "modus.requestTooLarge";
  if (status === 429) return "modus.rateLimited";
  if (status === 504) return "modus.timeout";
  if (status === 502) return "modus.upstreamError";
  if (status >= 500) return "modus.unavailable";
  return "modus.badRequest";
}

/** Reads `{"error": code}` from an error response (bounded); the body is never logged. */
export async function readRouterErrorCode(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
    const value = JSON.parse(text) as { error?: unknown };
    return typeof value?.error === "string" && /^[a-z_]{1,64}$/.test(value.error)
      ? value.error
      : undefined;
  } catch {
    return undefined;
  }
}

const COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  chatTemplateKwargs: {},
  zaiToolStream: false,
  supportsStrictMode: false,
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: false,
} as const;

/** The OpenAI chat-completions body the router forwards (always streamed, with usage). */
export function buildModusRequestBody(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Record<string, unknown> {
  const id = routerModelId(model.id);
  const compat = {
    ...COMPAT,
    // DeepSeek thinking mode wants reasoning_content echoed on assistant tool-call turns.
    requiresReasoningContentOnAssistantMessages: id.startsWith("deepseek/"),
  };
  const messages = convertMessages(
    { ...model, id, api: "openai-completions" } as Model<"openai-completions">,
    context,
    compat as Parameters<typeof convertMessages>[2],
  );
  const body: Record<string, unknown> = {
    model: id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options?.maxTokens) body.max_tokens = options.maxTokens;
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (context.tools && context.tools.length > 0) {
    body.tools = context.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  return body;
}

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function newOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
};

function parseUsage(raw: RawUsage): Usage {
  const prompt = raw.prompt_tokens || 0;
  const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
  const output = raw.completion_tokens || 0;
  const input = Math.max(0, prompt - cacheRead);
  return {
    ...emptyUsage(),
    input,
    output,
    cacheRead,
    totalTokens: input + output + cacheRead,
  };
}

function stopReasonFor(reason: string): StopReason {
  if (reason === "length") return "length";
  if (reason === "tool_calls" || reason === "function_call") return "toolUse";
  if (reason === "content_filter") return "error";
  return "stop";
}

class StreamFailure extends Error {
  constructor(readonly key: ModusTextKey) {
    super(key);
  }
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");
      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        if (data) yield data;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

type ToolBlock = ToolCall & { partialArgs: string };

/**
 * Minimal OpenAI chat-completions SSE → pi events: text, reasoning (reasoning_content /
 * reasoning / reasoning_text), tool calls by index, finish_reason, and the final usage chunk
 * (choices: []). The router rewrites `model` to the Modus id; the message keeps `model.id`.
 */
export async function pushOpenAiSse(
  body: ReadableStream<Uint8Array>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<void> {
  let text: TextContent | undefined;
  let thinking: ThinkingContent | undefined;
  const tools = new Map<number, ToolBlock>();
  let finished = false;
  const indexOf = (block: object) => output.content.indexOf(block as never);
  const endText = () => {
    if (!text) return;
    stream.push({
      type: "text_end",
      contentIndex: indexOf(text),
      content: text.text,
      partial: output,
    });
    text = undefined;
  };
  const endThinking = () => {
    if (!thinking) return;
    stream.push({
      type: "thinking_end",
      contentIndex: indexOf(thinking),
      content: thinking.thinking,
      partial: output,
    });
    thinking = undefined;
  };
  const endTools = () => {
    for (const block of tools.values()) {
      const { partialArgs, ...toolCall } = block;
      const args = partialArgs ? parseStreamingJson<Record<string, unknown>>(partialArgs) : {};
      const final: ToolCall = { ...toolCall, arguments: args ?? {} };
      output.content[indexOf(block)] = final;
      stream.push({
        type: "toolcall_end",
        contentIndex: output.content.indexOf(final),
        toolCall: final,
        partial: output,
      });
    }
    tools.clear();
  };

  for await (const data of sseData(body)) {
    let chunk: {
      usage?: RawUsage;
      choices?: Array<{
        finish_reason?: string | null;
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          reasoning_text?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      id?: string;
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.id) output.responseId ||= chunk.id;
    if (chunk.usage) output.usage = parseUsage(chunk.usage);
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) continue;
    const delta = choice.delta;
    if (delta) {
      const reasoning = delta.reasoning_content || delta.reasoning || delta.reasoning_text;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        endText();
        if (!thinking) {
          thinking = { type: "thinking", thinking: "" };
          output.content.push(thinking);
          stream.push({ type: "thinking_start", contentIndex: indexOf(thinking), partial: output });
        }
        thinking.thinking += reasoning;
        stream.push({
          type: "thinking_delta",
          contentIndex: indexOf(thinking),
          delta: reasoning,
          partial: output,
        });
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        endThinking();
        if (!text) {
          text = { type: "text", text: "" };
          output.content.push(text);
          stream.push({ type: "text_start", contentIndex: indexOf(text), partial: output });
        }
        text.text += delta.content;
        stream.push({
          type: "text_delta",
          contentIndex: indexOf(text),
          delta: delta.content,
          partial: output,
        });
      }
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === "number" ? call.index : tools.size;
        let block = tools.get(index);
        if (!block) {
          endText();
          endThinking();
          block = { type: "toolCall", id: call.id ?? "", name: "", arguments: {}, partialArgs: "" };
          tools.set(index, block);
          output.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex: indexOf(block), partial: output });
        }
        if (!block.id && call.id) block.id = call.id;
        if (!block.name && call.function?.name) block.name = call.function.name;
        const argsDelta = call.function?.arguments ?? "";
        if (argsDelta) {
          block.partialArgs += argsDelta;
          block.arguments = parseStreamingJson<Record<string, unknown>>(block.partialArgs) ?? {};
        }
        stream.push({
          type: "toolcall_delta",
          contentIndex: indexOf(block),
          delta: argsDelta,
          partial: output,
        });
      }
    }
    if (choice.finish_reason) {
      output.stopReason = stopReasonFor(choice.finish_reason);
      finished = true;
    }
  }
  endText();
  endThinking();
  endTools();
  if (!finished) throw new StreamFailure("modus.upstreamError");
  if (output.stopReason === "error") throw new StreamFailure("modus.upstreamError");
}

function isNetworkAuthError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { kind?: unknown }).kind === "network",
  );
}

export function createModusRouterStream(deps: ModusRouterDeps) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const newKey = deps.newIdempotencyKey ?? (() => crypto.randomUUID());
  const text = (key: ModusTextKey) => modusText(key, deps.locale?.());

  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const output = newOutput(model);
    void (async () => {
      const controller = new AbortController();
      const abort = () => controller.abort(options?.signal?.reason);
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted) abort();
      const timeoutMs = Math.min(
        Math.max(options?.timeoutMs ?? deps.timeoutMs ?? MODUS_REQUEST_TIMEOUT_MS, 1),
        deps.timeoutMs ?? MODUS_REQUEST_TIMEOUT_MS,
      );
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      let timedOut = false;
      controller.signal.addEventListener(
        "abort",
        () => {
          timedOut = !options?.signal?.aborted;
        },
        { once: true },
      );
      let reached = false;
      try {
        const url = deps.routerUrl();
        if (!url) throw new StreamFailure("modus.unavailable");
        let token = await deps.session.getAccessToken().catch((error: unknown) => {
          throw new StreamFailure(
            isNetworkAuthError(error) ? "modus.network" : "modus.sessionExpired",
          );
        });
        if (!token) throw new StreamFailure("modus.signInRequired");
        const body = JSON.stringify(buildModusRequestBody(model, context, options));
        const key = newKey();
        const anonKey = deps.anonKey?.();
        const post = async (bearer: string): Promise<Response> => {
          try {
            return await fetchImpl(`${url}/v1/chat/completions`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${bearer}`,
                ...(anonKey ? { apikey: anonKey } : {}),
                "content-type": "application/json",
                accept: "text/event-stream",
                "idempotency-key": key,
              },
              body,
              signal: controller.signal,
            });
          } catch (error) {
            if (controller.signal.aborted) throw error;
            throw new StreamFailure("modus.network");
          }
        };

        let response = await post(token);
        if (response.status === 401) {
          await response.body?.cancel().catch(() => undefined);
          try {
            token = await deps.session.refreshAccessToken(token);
          } catch (error) {
            if (isNetworkAuthError(error)) throw new StreamFailure("modus.network");
            await deps.session.expireSession().catch(() => undefined);
            throw new StreamFailure("modus.sessionExpired");
          }
          // The single retry after a 401 reuses the SAME Idempotency-Key (never claimed).
          response = await post(token);
          if (response.status === 401) {
            await response.body?.cancel().catch(() => undefined);
            await deps.session.expireSession().catch(() => undefined);
            throw new StreamFailure("modus.sessionExpired");
          }
        }
        reached = true;
        await options?.onResponse?.({ status: response.status, headers: {} }, model);
        if (!response.ok) {
          throw new StreamFailure(
            modusErrorKey(response.status, await readRouterErrorCode(response)),
          );
        }
        if (!response.body) throw new StreamFailure("modus.upstreamError");
        stream.push({ type: "start", partial: output });
        try {
          await pushOpenAiSse(response.body, output, stream);
        } catch (error) {
          if (error instanceof StreamFailure || controller.signal.aborted) throw error;
          // Network error mid-stream: no automatic retry (the router already charged usage).
          throw new StreamFailure("modus.network");
        }
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
      } catch (error) {
        for (const block of output.content) delete (block as { partialArgs?: string }).partialArgs;
        const userAbort = Boolean(options?.signal?.aborted);
        output.stopReason = userAbort ? "aborted" : "error";
        output.errorMessage = userAbort
          ? text("modus.cancelled")
          : error instanceof StreamFailure
            ? text(error.key)
            : timedOut
              ? text("modus.timeout")
              : text("modus.network");
        stream.push({ type: "error", reason: output.stopReason, error: output });
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
        stream.end();
        if (reached) deps.onCallSettled?.();
      }
    })();
    return stream;
  };
}
