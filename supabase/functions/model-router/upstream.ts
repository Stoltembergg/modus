import type { CatalogModel } from "../_shared/model-catalog.ts";
import type { UpstreamConfig } from "./config.ts";
import type { Usage } from "./pricing.ts";

/**
 * Upstream adapters keyed by the catalog `api`. Only `openai-completions` ships
 * (POST {baseUrl}/chat/completions). The request is REBUILT from an allowlist of body
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
  stream: boolean,
  upstream: UpstreamConfig,
  signal: AbortSignal,
): UpstreamRequest {
  const payload: Record<string, unknown> = { model: model.upstreamId };
  for (const field of FORWARDED_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  payload.max_tokens = maxTokens;
  payload.stream = stream;
  // Without it the final chunk has no usage and we would have to estimate.
  if (stream) payload.stream_options = { include_usage: true };
  return {
    url: `${upstream.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
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

/**
 * Watches the SSE bytes we pass through: remembers the last `usage` and counts output
 * characters of every delta. Never stores the content itself.
 */
export class SseUsageTracker {
  usage: Usage | null = null;
  outputChars = 0;
  #decoder = new TextDecoder();
  #buffer = "";

  push(chunk: Uint8Array): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      this.#line(this.#buffer.slice(0, newline));
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
    }
    // A single absurdly long line is not ours to buffer forever.
    if (this.#buffer.length > 4_000_000) {
      this.outputChars += this.#buffer.length;
      this.#buffer = "";
    }
  }

  #line(rawLine: string): void {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const value = JSON.parse(data) as { usage?: unknown; choices?: unknown };
      const usage = parseUsage(value.usage);
      if (usage) this.usage = usage;
      if (Array.isArray(value.choices)) {
        for (const choice of value.choices) {
          this.outputChars += outputChars((choice as { delta?: unknown }).delta);
        }
      }
    } catch {
      // Not JSON: count it as output so a garbled stream is never free.
      this.outputChars += data.length;
    }
  }
}
