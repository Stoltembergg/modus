import type { GetUser } from "../_shared/auth.ts";
import { errorResponse, HttpError, json } from "../_shared/http.ts";
import { type CatalogModel, findModel } from "../_shared/model-catalog.ts";
import { ReserveError, type RouterDb } from "../_shared/router-db.ts";
import type { RouterConfig, UpstreamConfig } from "./config.ts";
import {
  affordableMaxTokens,
  creditsFor,
  estimateOutputTokens,
  estimateTokens,
  type Markup,
  type Usage,
} from "./pricing.ts";
import { buildOpenAiCompletionsRequest, inspectCompletion, SseUsageTracker } from "./upstream.ts";

/**
 * model-router (B4a). OpenAI-compatible:
 *   POST /v1/chat/completions   GET /v1/models
 * Order for a completion:
 *   1. JWT (401)                       2. server config: CREDIT_MARKUP (503
 *      pricing_not_configured), upstream URL / key (503 provider_not_configured),
 *      checked before the key is claimed so a fixed deploy can be retried
 *   3. Idempotency-Key (400 missing / malformed), body <= 1 MB (413), JSON (400/415)
 *   4. claim the key: a repeat is ALWAYS 409 (same body sha256 -> idempotency_replay,
 *      different body -> idempotency_conflict), whatever the first attempt returned
 *   5. model id `<provider>/<id>`: malformed 400 invalid_model; not in the server
 *      table -> 503 model_not_configured if the plan lists it, else 404
 *      model_not_found; not in plans.allowed_models -> 403 model_not_in_plan.
 *      All before reserving.
 *   6. prompt estimate ceil(chars / 4) > contextWindow -> 400 context_length_exceeded
 *   7. max_tokens forced = min(requested, model maxTokens, context left, affordable);
 *      402 insufficient_credits when not even min(forced, 256) fits; reserve the
 *      worst case (no cache hits, tier by prompt size) -> 402 / 429
 *   8. upstream (adapter by catalog api; stream_options.include_usage when streaming)
 *   9. settle with real usage (capped at the reservation). Upstream error / timeout
 *      before the response: full release. Stream cut (client gone, upstream error,
 *      10 min cap) or no usage: conservative estimate (pricing.ts), capped.
 * Logs only ids, model, token counts and credits: never prompts, responses or keys.
 */
export const MAX_BODY_BYTES = 1024 * 1024;
export const MIN_OUTPUT_TOKENS = 256;
export const MAX_ACTIVE_RESERVATIONS = 4;
/** Reservation TTL (B1 sweep refunds after it); longer than the stream cap. */
export const STREAM_CAP_MS = 10 * 60 * 1000;
/** Streaming only: time to the upstream response headers. */
export const HEADERS_TIMEOUT_MS = 60 * 1000;

const KEY = /^[A-Za-z0-9._:-]{1,200}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ROUTE = /^(?:\/functions\/v1)?(?:\/model-router)?(\/v1\/(?:chat\/completions|models))\/?$/;

export type RouterLog = (event: Record<string, unknown>) => void;

export type RouterDeps = {
  db: RouterDb;
  getUser: GetUser;
  config: RouterConfig;
  catalog: readonly CatalogModel[];
  fetch?: typeof fetch;
  /** Keeps settlement alive after the response (EdgeRuntime.waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void;
  log?: RouterLog;
  limits?: Partial<{
    maxBodyBytes: number;
    headersTimeoutMs: number;
    streamCapMs: number;
    maxActive: number;
  }>;
};

function configOr503<T>(load: () => T, code: string): T {
  try {
    return load();
  } catch (error) {
    // Message only: never the value.
    console.error(
      `[model-router] configuration error: ${error instanceof Error ? error.message : "invalid"}`,
    );
    throw new HttpError(503, code);
  }
}

async function readBody(req: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "body_too_large");
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "body_too_large");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function positiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, `invalid_${field}`);
  }
  return value;
}

type Parsed = {
  body: Record<string, unknown>;
  modelId: string;
  stream: boolean;
  requestedMaxTokens: number | undefined;
  promptChars: number;
};

function parseCompletionBody(bytes: Uint8Array, contentType: string): Parsed {
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "json_required");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_body");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.model !== "string" || !MODEL_ID.test(body.model)) {
    throw new HttpError(400, "invalid_model");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, "invalid_messages");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new HttpError(400, "invalid_stream");
  }
  // n > 1 would multiply the output beyond what was reserved.
  if (body.n !== undefined && body.n !== 1) throw new HttpError(400, "unsupported_n");
  const a = positiveInt(body.max_completion_tokens, "max_tokens");
  const b = positiveInt(body.max_tokens, "max_tokens");
  const requested = a !== undefined && b !== undefined ? Math.min(a, b) : (a ?? b);
  const promptChars =
    JSON.stringify(body.messages).length +
    (body.tools === undefined ? 0 : JSON.stringify(body.tools).length) +
    (body.response_format === undefined ? 0 : JSON.stringify(body.response_format).length);
  return {
    body,
    modelId: body.model,
    stream: body.stream === true,
    requestedMaxTokens: requested,
    promptChars,
  };
}

export function createRouterHandler(deps: RouterDeps): (req: Request) => Promise<Response> {
  const fetchImpl = deps.fetch ?? fetch;
  const log: RouterLog = deps.log ?? ((event) => console.log(JSON.stringify(event)));
  const limits = {
    maxBodyBytes: MAX_BODY_BYTES,
    headersTimeoutMs: HEADERS_TIMEOUT_MS,
    streamCapMs: STREAM_CAP_MS,
    maxActive: MAX_ACTIVE_RESERVATIONS,
    ...deps.limits,
  };

  async function listModels(userId: string): Promise<Response> {
    const plan = await deps.db.getPlan(userId);
    return json(200, {
      object: "list",
      plan: plan.plan,
      data: deps.catalog.map((model) => ({
        id: model.id,
        object: "model",
        owned_by: model.provider,
        name: model.name,
        allowed: plan.allowedModels === null || plan.allowedModels.includes(model.id),
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
      })),
    });
  }

  async function completion(req: Request, userId: string): Promise<Response> {
    const markup = configOr503(deps.config.markup, "pricing_not_configured");
    const upstream = configOr503(deps.config.upstream, "provider_not_configured");

    const key = req.headers.get("idempotency-key");
    if (!key) throw new HttpError(400, "idempotency_key_required");
    if (!KEY.test(key)) throw new HttpError(400, "invalid_idempotency_key");
    const bytes = await readBody(req, limits.maxBodyBytes);

    const claim = await deps.db.claimRequest(userId, key, await sha256Hex(bytes));
    if (claim !== "claimed") throw new HttpError(409, claim);

    const parsed = parseCompletionBody(bytes, req.headers.get("content-type") ?? "");
    const plan = await deps.db.getPlan(userId);
    const listed = plan.allowedModels?.includes(parsed.modelId) ?? false;
    const model = findModel(deps.catalog, parsed.modelId);
    if (!model)
      throw new HttpError(listed ? 503 : 404, listed ? "model_not_configured" : "model_not_found");
    if (plan.allowedModels !== null && !listed) throw new HttpError(403, "model_not_in_plan");
    if (model.api !== "openai-completions") throw new HttpError(503, "provider_not_configured");

    const promptTokens = estimateTokens(parsed.promptChars);
    if (promptTokens > model.contextWindow) throw new HttpError(400, "context_length_exceeded");
    const wanted = Math.max(
      1,
      Math.min(
        parsed.requestedMaxTokens ?? model.maxTokens,
        model.maxTokens,
        model.contextWindow - promptTokens,
      ),
    );
    const balance = await deps.db.getBalance(userId);
    if (balance === null) throw new HttpError(402, "insufficient_credits");
    const maxTokens = affordableMaxTokens(model, promptTokens, wanted, balance, markup);
    if (maxTokens < Math.min(wanted, MIN_OUTPUT_TOKENS)) {
      throw new HttpError(402, "insufficient_credits");
    }
    const reserved = Math.max(
      1,
      creditsFor(model, { promptTokens, cachedTokens: 0, completionTokens: maxTokens }, markup),
    );
    try {
      await deps.db.reserve(userId, key, reserved, limits.maxActive);
    } catch (error) {
      if (error instanceof ReserveError) {
        throw new HttpError(error.code === "too_many_requests" ? 429 : 402, error.code);
      }
      throw error;
    }

    return await forward({
      req,
      userId,
      key,
      model,
      parsed,
      upstream,
      markup,
      maxTokens,
      reserved,
      promptTokens,
    });
  }

  type Ctx = {
    req: Request;
    userId: string;
    key: string;
    model: CatalogModel;
    parsed: Parsed;
    upstream: UpstreamConfig;
    markup: Markup;
    maxTokens: number;
    reserved: number;
    promptTokens: number;
  };

  async function settle(
    ctx: Ctx,
    reason: string,
    usage: Usage | null,
    outputChars: number,
    release = false,
  ): Promise<void> {
    const estimated = !release && usage === null;
    const final: Usage = release
      ? { promptTokens: 0, cachedTokens: 0, completionTokens: 0 }
      : (usage ?? {
          promptTokens: ctx.promptTokens,
          cachedTokens: 0,
          completionTokens: estimateOutputTokens(outputChars),
        });
    const credits = release ? 0 : creditsFor(ctx.model, final, ctx.markup);
    const int = (n: number) => Math.min(2147483647, Math.max(0, Math.floor(n)));
    try {
      const result = await deps.db.settle({
        userId: ctx.userId,
        requestId: ctx.key,
        credits,
        model: ctx.model.id,
        provider: ctx.model.provider,
        inputTokens: int(final.promptTokens),
        outputTokens: int(final.completionTokens),
      });
      log({
        event: "model_router.settled",
        reason,
        request_id: ctx.key,
        user_id: ctx.userId,
        model: ctx.model.id,
        input_tokens: final.promptTokens,
        cached_tokens: final.cachedTokens,
        output_tokens: final.completionTokens,
        estimated,
        credits,
        reserved: ctx.reserved,
        charged: result.charged,
        code: result.code,
      });
    } catch (error) {
      // The reservation stays active and the B1 sweep refunds it at expiry (never an
      // orphan, never a charge above the reservation).
      log({
        event: "model_router.settle_failed",
        reason,
        request_id: ctx.key,
        user_id: ctx.userId,
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  async function forward(ctx: Ctx): Promise<Response> {
    const abort = new AbortController();
    const onClientGone = () => abort.abort("client_disconnect");
    ctx.req.signal?.addEventListener("abort", onClientGone, { once: true });
    const cap = setTimeout(() => abort.abort("stream_cap"), limits.streamCapMs);
    // Streams must start within headersTimeoutMs. A non-stream gateway answers only when
    // the completion is done, so those are bounded by the total cap alone.
    const headersTimer = ctx.parsed.stream
      ? setTimeout(() => abort.abort("upstream_timeout"), limits.headersTimeoutMs)
      : undefined;
    const cleanup = () => {
      clearTimeout(cap);
      clearTimeout(headersTimer);
      ctx.req.signal?.removeEventListener("abort", onClientGone);
    };

    const request = buildOpenAiCompletionsRequest(
      ctx.model,
      ctx.parsed.body,
      ctx.maxTokens,
      ctx.parsed.stream,
      ctx.upstream,
      abort.signal,
    );
    let response: Response;
    try {
      response = await fetchImpl(request.url, request.init);
    } catch {
      cleanup();
      const reason = String(abort.signal.reason ?? "upstream_error");
      if (reason === "client_disconnect") {
        // The prompt reached the provider: bill the prompt estimate, nothing else.
        await settle(ctx, reason, null, 0);
        throw new HttpError(499, "client_closed_request");
      }
      await settle(ctx, reason, null, 0, true);
      throw new HttpError(
        reason === "upstream_error" ? 502 : 504,
        reason === "upstream_error" ? "upstream_error" : "upstream_timeout",
      );
    }
    clearTimeout(headersTimer);

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      cleanup();
      await settle(ctx, "upstream_status", null, 0, true);
      return json(502, { error: "upstream_error", upstream_status: response.status });
    }

    if (!ctx.parsed.stream) {
      let text: string;
      try {
        text = await response.text();
      } catch {
        cleanup();
        const reason = String(abort.signal.reason ?? "upstream_error");
        await settle(ctx, reason, null, 0);
        throw new HttpError(
          reason === "client_disconnect" ? 499 : 504,
          reason === "client_disconnect" ? "client_closed_request" : "upstream_timeout",
        );
      }
      cleanup();
      const { usage, outputChars } = inspectCompletion(text);
      await settle(ctx, "complete", usage, outputChars);
      return new Response(text, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const tracker = new SseUsageTracker();
    const reader = response.body.getReader();
    let settled: Promise<void> | undefined;
    const finish = (reason: string) => {
      settled ??= (async () => {
        cleanup();
        await settle(ctx, reason, tracker.usage, tracker.outputChars);
      })();
      deps.waitUntil?.(settled);
      return settled;
    };

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          await finish(String(abort.signal.reason ?? "upstream_error"));
          controller.error(new Error("upstream stream failed"));
          return;
        }
        if (chunk.done) {
          // Settle before closing so the runtime keeps the request alive for it.
          await finish("complete");
          controller.close();
          return;
        }
        tracker.push(chunk.value);
        controller.enqueue(chunk.value);
      },
      async cancel() {
        abort.abort("client_disconnect");
        await reader.cancel().catch(() => {});
        await finish("client_disconnect");
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  return async (req) => {
    try {
      const route = ROUTE.exec(new URL(req.url).pathname)?.[1];
      if (!route) throw new HttpError(404, "not_found");
      const method = route === "/v1/models" ? "GET" : "POST";
      if (req.method !== method) throw new HttpError(405, "method_not_allowed");
      const user = await deps.getUser(req);
      if (!user) throw new HttpError(401, "unauthorized");
      return route === "/v1/models" ? await listModels(user.id) : await completion(req, user.id);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
