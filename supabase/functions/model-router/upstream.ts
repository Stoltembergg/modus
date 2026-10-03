import type { CatalogModel } from "../_shared/model-catalog.ts";
import type { UpstreamConfig } from "./config.ts";
import type { Usage } from "./pricing.ts";

/**
 * Upstream adapters keyed by the catalog `api`. Only `openai-completions` ships
 * (POST {baseUrl}/chat/completions). The upstream is ALWAYS called with `stream: true`
 * and `stream_options.include_usage: true`, whatever the client asked: the router sees
 * output as it arrives (progressive cost, cap, headers timeout) on both paths, and for a
 * non-stream client it assembles the chat.completion itself (CompletionAssembler). The request is REBUILT from an allowlist of body
 * fields; no client header is ever forwarded (only content-type, accept and the
 * server's own Authorization).
 */
export const FORWARDED_FIELDS = [
  "messages",
  "temperature",
  "top_p",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "logprobs",
  "top_logprobs",
  "reasoning_effort",
  "thinking",
  "enable_thinking",
] as const;

export type UpstreamRequest = { url: string; init: RequestInit };

export function buildOpenAiCompletionsRequest(
  model: CatalogModel,
  body: Record<string, unknown>,
  maxTokens: number,
  upstream: UpstreamConfig,
  signal: AbortSignal,
): UpstreamRequest {
  const payload: Record<string, unknown> = { model: model.upstreamId };
  for (const field of FORWARDED_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  payload.max_tokens = maxTokens;
  payload.stream = true;
  // Without it the final chunk has no usage and we would have to estimate.
  payload.stream_options = { include_usage: true };
  return {
    url: `${upstream.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${upstream.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal,
      redirect: "error",
    },
  };
}

function count(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/** Output characters in an OpenAI-style message or delta (text, reasoning, tool args). */
export function outputChars(part: unknown): number {
  if (!part || typeof part !== "object") return 0;
  const p = part as Record<string, unknown>;
  let total = count(p.content) + count(p.reasoning_content) + count(p.reasoning);
  if (Array.isArray(p.tool_calls)) {
    for (const call of p.tool_calls) {
      const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function;
      total += count(fn?.name) + count(fn?.arguments);
    }
  }
  return total;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** OpenAI / DeepSeek usage object -> Usage; null when absent or malformed. */
export function parseUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const prompt = tokenCount(u.prompt_tokens);
  const completion = tokenCount(u.completion_tokens);
  if (prompt === null || completion === null) return null;
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = tokenCount(details?.cached_tokens) ?? tokenCount(u.prompt_cache_hit_tokens) ?? 0;
  return {
    promptTokens: prompt,
    cachedTokens: Math.min(cached, prompt),
    completionTokens: completion,
  };
}

/** Non-stream response body: usage and output characters (for the fallback estimate). */
export function inspectCompletion(text: string): { usage: Usage | null; outputChars: number } {
  try {
    const value = JSON.parse(text) as { usage?: unknown; choices?: unknown };
    let chars = 0;
    if (Array.isArray(value.choices)) {
      for (const choice of value.choices)
        chars += outputChars((choice as { message?: unknown }).message);
    }
    return { usage: parseUsage(value.usage), outputChars: chars };
  } catch {
    return { usage: null, outputChars: text.length };
  }
}

/** Max non-SSE text kept for the JSON fallback, and max length of one SSE line. */
const RAW_LIMIT = 4_000_000;

type ToolCallParts = { id?: unknown; type?: unknown; name: string; args: string };
type ChoiceParts = {
  role: unknown;
  content: string;
  reasoning: string | null;
  refusal: string | null;
  tools: Map<number, ToolCallParts>;
  finish: unknown;
  hasLogprobs: boolean;
  logprobs: unknown[] | null;
};

/**
 * Rebuilds a non-stream `chat.completion` from the upstream SSE chunks, in the shape of
 * a genuine non-stream OpenAI response:
 *   id, object "chat.completion", created, model, system_fingerprint (when sent),
 *   choices[]: { index, message: { role, content, reasoning_content?, refusal?,
 *   tool_calls? }, logprobs (when sent), finish_reason }, usage (final usage chunk).
 * `content` is the concatenation of the deltas, or null when there was no text (as
 * OpenAI does for tool-call-only answers). tool_calls are merged by `index`: the first
 * id / type / function.name seen and the concatenated function.arguments.
 */
export class CompletionAssembler {
  /** Reported `model` (the Modus id); the upstream's own model name never leaves. */
  #reportedModel: string | undefined;
  #id: unknown;
  #created: unknown;
  #model: unknown;
  #fingerprint: unknown;
  #hasFingerprint = false;
  #usage: unknown;
  #choices = new Map<number, ChoiceParts>();

  constructor(reportedModel?: string) {
    this.#reportedModel = reportedModel;
  }

  push(chunk: Record<string, unknown>): void {
    this.#id ??= chunk.id;
    this.#created ??= chunk.created;
    this.#model ??= chunk.model;
    if ("system_fingerprint" in chunk && !this.#hasFingerprint) {
      this.#hasFingerprint = true;
      this.#fingerprint = chunk.system_fingerprint;
    }
    if (chunk.usage && typeof chunk.usage === "object") this.#usage = chunk.usage;
    if (!Array.isArray(chunk.choices)) return;
    for (const raw of chunk.choices) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      const index = typeof c.index === "number" ? c.index : 0;
      let parts = this.#choices.get(index);
      if (!parts) {
        parts = {
          role: undefined,
          content: "",
          reasoning: null,
          refusal: null,
          tools: new Map(),
          finish: null,
          hasLogprobs: false,
          logprobs: null,
        };
        this.#choices.set(index, parts);
      }
      if ("logprobs" in c) {
        parts.hasLogprobs = true;
        const content = (c.logprobs as { content?: unknown } | null)?.content;
        if (Array.isArray(content)) parts.logprobs = [...(parts.logprobs ?? []), ...content];
      }
      if (c.finish_reason !== undefined && c.finish_reason !== null) parts.finish = c.finish_reason;
      const delta = c.delta as Record<string, unknown> | undefined;
      if (!delta || typeof delta !== "object") continue;
      parts.role ??= delta.role;
      if (typeof delta.content === "string") parts.content += delta.content;
      if (typeof delta.reasoning_content === "string") {
        parts.reasoning = (parts.reasoning ?? "") + delta.reasoning_content;
      }
      if (typeof delta.refusal === "string") parts.refusal = (parts.refusal ?? "") + delta.refusal;
      if (Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          const call = (rawCall ?? {}) as Record<string, unknown>;
          const at = typeof call.index === "number" ? call.index : parts.tools.size;
          let tool = parts.tools.get(at);
          if (!tool) {
            tool = { name: "", args: "" };
            parts.tools.set(at, tool);
          }
          tool.id ??= call.id;
          tool.type ??= call.type;
          const fn = (call.function ?? {}) as { name?: unknown; arguments?: unknown };
          if (typeof fn.name === "string") tool.name += fn.name;
          if (typeof fn.arguments === "string") tool.args += fn.arguments;
        }
      }
    }
  }

  result(): Record<string, unknown> {
    const choices = [...this.#choices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, parts]) => {
        const message: Record<string, unknown> = {
          role: parts.role ?? "assistant",
          content: parts.content === "" ? null : parts.content,
        };
        if (parts.reasoning !== null) message.reasoning_content = parts.reasoning;
        if (parts.refusal !== null) message.refusal = parts.refusal;
        if (parts.tools.size > 0) {
          message.tool_calls = [...parts.tools.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, tool]) => ({
              id: tool.id,
              type: tool.type ?? "function",
              function: { name: tool.name, arguments: tool.args },
            }));
        }
        const choice: Record<string, unknown> = { index, message };
        if (parts.hasLogprobs) {
          choice.logprobs = parts.logprobs === null ? null : { content: parts.logprobs };
        }
        choice.finish_reason = parts.finish;
        return choice;
      });
    const out: Record<string, unknown> = {
      id: this.#id,
      object: "chat.completion",
      created: this.#created,
      model: this.#reportedModel ?? this.#model,
      choices,
    };
    if (this.#usage !== undefined) out.usage = this.#usage;
    if (this.#hasFingerprint) out.system_fingerprint = this.#fingerprint;
    return out;
  }
}

/**
 * Watches the upstream SSE bytes: remembers the last `usage`, counts output characters
 * of every delta and (optionally) feeds a CompletionAssembler. If the upstream ignored
 * `stream: true` and answered with one JSON completion, end() reads usage and output
 * from it instead (`jsonBody`), so that case is never free either.
 */
export class SseUsageTracker {
  usage: Usage | null = null;
  outputChars = 0;
  /** The upstream's own JSON completion, when it did not stream (see end()). */
  jsonBody: string | null = null;
  #decoder = new TextDecoder();
  #buffer = "";
  #sawData = false;
  #raw = "";
  #assembler: CompletionAssembler | undefined;
  #model: { reported: string; upstream: string } | undefined;
  #encoder = new TextEncoder();
  #ended = false;

  /**
   * `model`: when set, every `data:` JSON line is re-serialized with `model` = the Modus
   * id (push / end return the rewritten bytes to forward), and so is `jsonBody`.
   */
  constructor(assembler?: CompletionAssembler, model?: { reported: string; upstream: string }) {
    this.#assembler = assembler;
    this.#model = model;
  }

  /**
   * Feeds upstream bytes. Returns the bytes to forward: only COMPLETE lines (buffered
   * across arbitrary chunk boundaries), with `model` rewritten on `data:` JSON lines;
   * `data: [DONE]`, comments and any other line are forwarded byte for byte.
   */
  push(chunk: Uint8Array): Uint8Array {
    const text = this.#decoder.decode(chunk, { stream: true });
    if (!this.#sawData && this.#raw.length < RAW_LIMIT) this.#raw += text;
    this.#buffer += text;
    let out = "";
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      out += `${this.#line(this.#buffer.slice(0, newline))}\n`;
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
    }
    // A single absurdly long line is not ours to buffer forever: count it and forward
    // it with the upstream model name replaced textually.
    if (this.#buffer.length > RAW_LIMIT) {
      this.outputChars += this.#buffer.length;
      out += this.#scrub(this.#buffer);
      this.#buffer = "";
    }
    return this.#encoder.encode(out);
  }

  /** End of the upstream body (or of what we got): flush the last line; returns its bytes. */
  end(): Uint8Array {
    if (this.#ended) return new Uint8Array();
    this.#ended = true;
    this.#buffer += this.#decoder.decode();
    const out = this.#buffer ? this.#line(this.#buffer) : "";
    this.#buffer = "";
    if (!this.#sawData && this.#raw.trim().startsWith("{")) {
      const inspected = inspectCompletion(this.#raw);
      this.usage = inspected.usage;
      this.outputChars = inspected.outputChars;
      this.jsonBody = this.#withModel(this.#raw);
    }
    this.#raw = "";
    return this.#encoder.encode(out);
  }

  /** A JSON document with `model` replaced (textual scrub if it does not parse). */
  #withModel(json: string): string {
    if (!this.#model) return json;
    try {
      const value = JSON.parse(json);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        value.model = this.#model.reported;
        return JSON.stringify(value);
      }
    } catch {
      // fall through
    }
    return this.#scrub(json);
  }

  #scrub(text: string): string {
    if (!this.#model) return text;
    return text.replaceAll(
      JSON.stringify(this.#model.upstream),
      JSON.stringify(this.#model.reported),
    );
  }

  /** Tracks one line; returns it as it must be forwarded (without the newline). */
  #line(rawLine: string): string {
    const line = rawLine.trim();
    // Comments / blank / event: lines pass untouched; anything else non-SSE (an upstream
    // that answered JSON to a stream request) gets the model name scrubbed.
    if (!line.startsWith("data:")) {
      return line === "" || line.startsWith(":") || /^(event|id|retry):/.test(line)
        ? rawLine
        : this.#scrub(rawLine);
    }
    this.#sawData = true;
    this.#raw = "";
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return rawLine;
    try {
      const value = JSON.parse(data) as Record<string, unknown>;
      const usage = parseUsage(value.usage);
      if (usage) this.usage = usage;
      if (Array.isArray(value.choices)) {
        for (const choice of value.choices) {
          this.outputChars += outputChars((choice as { delta?: unknown }).delta);
        }
      }
      this.#assembler?.push(value);
      if (this.#model && value && typeof value === "object" && "model" in value) {
        value.model = this.#model.reported;
        return `data: ${JSON.stringify(value)}${rawLine.endsWith("\r") ? "\r" : ""}`;
      }
      return rawLine;
    } catch {
      // Not JSON: count it as output so a garbled stream is never free.
      this.outputChars += data.length;
      return this.#scrub(rawLine);
    }
  }
}
