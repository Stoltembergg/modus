import type { GetUser } from "../_shared/auth.ts";
import { errorResponse, HttpError, json } from "../_shared/http.ts";
import { type CatalogModel, findModel } from "../_shared/model-catalog.ts";
import { ReserveError, type RouterDb, unlockPackFor } from "../_shared/router-db.ts";
import {
  type DurationLimits,
  type RouterConfig,
  SETTLE_RETRIES,
  SETTLE_RETRY_DELAY_MS,
  type UpstreamConfig,
} from "./config.ts";
import {
  affordableMaxTokens,
  creditsFor,
  estimateOutputTokens,
  estimateTokens,
  type Markup,
  type Usage,
  worstCaseCredits,
} from "./pricing.ts";
import {
  buildOpenAiCompletionsRequest,
  CompletionAssembler,
  IGNORED_EFFORT_FIELDS,
  SseUsageTracker,
} from "./upstream.ts";

/**
 * model-router (B4a). OpenAI-compatible:
 *   POST /v1/chat/completions   GET /v1/models
 * GET /v1/models: { plan, default_model (L3a), data: [{ id, name, owned_by, allowed,
 *   context_window, max_tokens, unlock_pack? }] }; unlock_pack (L3b) only on locked models:
 *   { id, credits } of the smallest active credit pack whose access plan allows it, or null
 *   (always null while private.billing_settings.mercadopago_enabled is false).
 * Order for a completion:
 *   1. JWT (401)                       2. server config: CREDIT_MARKUP (503
 *      pricing_not_configured), MODUS_ROUTER_MAX_DURATION_MS (503 router_not_configured),
 *      upstream URL and the key of the model's vibi group (503 provider_not_configured,
 *      never another group's key), checked before the key is claimed so a fixed deploy
 *      can be retried
 *   3. Idempotency-Key (400 missing / malformed), body <= 1 MB (413), JSON (400/415)
 *   4. claim the key: a repeat is ALWAYS 409 (same body sha256 -> idempotency_replay,
 *      different body -> idempotency_conflict), whatever the first attempt returned
 *   5. model id `<provider>/<id>`: malformed 400 invalid_model. L3a: no model (absent or
 *      null) -> the plan's public.plans.default_model (none -> 400 model_required; its group
 *      key is checked before the claim); a named model is never substituted. Not in the server
 *      table -> 503 model_not_configured if the plan lists it, else 404
 *      model_not_found; not in plans.allowed_models -> 403 model_not_in_plan.
 *      All before reserving.
 *   6. prompt estimate ceil(chars / 4) > contextWindow -> 400 context_length_exceeded
 *   7. max_tokens forced = min(requested, model maxTokens, context left, affordable);
 *      402 insufficient_credits when not even min(forced, 256) fits; reserve the
 *      worst case (no cache hits, tier by prompt size) -> 402 / 429
 *   8. store the minimum cost (prompt estimate) BEFORE the fetch; if that store fails:
 *      release + 503 billing_unavailable, the upstream is never called. Upstream is
 *      ALWAYS called with stream: true + stream_options.include_usage (a non-stream
 *      client gets the chat.completion assembled by the router), so both paths have
 *      the same headers timeout, cap and progressive cost updates (<= every 5 s).
 *   9. settle (billing rule): full release ONLY when the upstream provably did not take
 *      the request (fetch failed without our abort, or non-2xx). After a 2xx, and on our
 *      own timeouts (stream headers min(60 s, cap), the MODUS_ROUTER_MAX_DURATION_MS cap,
 *      default 120 s, counted from the request's arrival), real usage or the conservative
 *      estimate (pricing.ts), capped at the reservation. A client disconnect does not
 *      stop the upstream: it is drained under waitUntil and settled with its usage.
 *      settle_usage is retried 2 times, then the cost is stored for the expiry sweep.
 *      The cost is also stored BEFORE the fetch (prompt estimate) and refreshed while
 *      streaming (<= every 5 s), so a worker killed by the 150 s wall clock is still
 *      charged by the sweep; a full release zeroes the stored cost first.
 * Logs only ids, model, token counts and credits: never prompts, responses or keys.
 */
export const MAX_BODY_BYTES = 1024 * 1024;
export const MIN_OUTPUT_TOKENS = 256;
export const MAX_ACTIVE_RESERVATIONS = 4;
/** While streaming, the stored cost is refreshed at most this often. */
export const PROGRESS_INTERVAL_MS = 5_000;

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
    /** Lower bound override for tests; the effective value is min(this, the cap). */
    headersTimeoutMs: number;
    maxActive: number;
    progressIntervalMs: number;
    settleRetries: number;
    settleRetryDelayMs: number;
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

/** The model id of a JSON body, or undefined (full validation happens after the claim). */
function peekModel(bytes: Uint8Array): string | undefined {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value?.model === "string" ? value.model : undefined;
  } catch {
    return undefined;
  }
}

/** L3a: a JSON object body with no `model` (absent or null): the plan default applies. */
function omitsModel(bytes: Uint8Array): boolean {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value.model === undefined || value.model === null)
    );
  } catch {
    return false;
  }
}

type Parsed = {
  body: Record<string, unknown>;
  /** Undefined = the request named no model (L3a: the plan default applies). */
  modelId: string | undefined;
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
  const omitted = body.model === undefined || body.model === null;
  if (!omitted && (typeof body.model !== "string" || !MODEL_ID.test(body.model))) {
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
    modelId: omitted ? undefined : (body.model as string),
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
    headersTimeoutMs: Number.POSITIVE_INFINITY,
    maxActive: MAX_ACTIVE_RESERVATIONS,
    progressIntervalMs: PROGRESS_INTERVAL_MS,
    settleRetries: SETTLE_RETRIES,
    settleRetryDelayMs: SETTLE_RETRY_DELAY_MS,
    ...deps.limits,
  };

  async function listModels(userId: string): Promise<Response> {
    const plan = await deps.db.getPlan(userId);
    // L3a: the plan default (what a request without `model` runs on); null = none.
    const defaultModel = await deps.db.getPlanDefaultModel(plan.plan);
    const allowed = (id: string) => plan.allowedModels === null || plan.allowedModels.includes(id);
    // L3b: packs are read only when some model is locked (Pro and up skip the query) and
    // packs are on sale (private.billing_settings.mercadopago_enabled); off → every
    // unlock_pack is null and the pack query is skipped.
    const anyLocked = !deps.catalog.every((model) => allowed(model.id));
    const packs =
      anyLocked && (await deps.db.getMercadoPagoEnabled()) ? await deps.db.listUnlockPacks() : [];
    return json(200, {
      object: "list",
      plan: plan.plan,
      default_model: defaultModel,
      data: deps.catalog.map((model) => ({
        id: model.id,
        object: "model",
        owned_by: model.provider,
        name: model.name,
        allowed: allowed(model.id),
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
        // L3b: only on locked models: the smallest pack that unlocks it, or null.
        ...(allowed(model.id) ? {} : { unlock_pack: unlockPackFor(model.id, packs) }),
      })),
    });
  }

  /** The key of the model's own vibi group; missing -> 503 (never another group's key). */
  function upstreamFor(model: CatalogModel, baseUrl: string): UpstreamConfig {
    const apiKey = configOr503(
      () => deps.config.upstreamKey(model.upstreamGroup),
      "provider_not_configured",
    );
    return { baseUrl, apiKey };
  }

  async function completion(req: Request, userId: string, startedAt: number): Promise<Response> {
    const markup = configOr503(deps.config.markup, "pricing_not_configured");
    const duration = configOr503(deps.config.duration, "router_not_configured");
    const baseUrl = configOr503(deps.config.baseUrl, "provider_not_configured");

    const key = req.headers.get("idempotency-key");
    if (!key) throw new HttpError(400, "idempotency_key_required");
    if (!KEY.test(key)) throw new HttpError(400, "invalid_idempotency_key");
    const bytes = await readBody(req, limits.maxBodyBytes);
    // Config check before the claim too: a missing group key is a deploy problem, and the
    // client must be able to retry with the same Idempotency-Key once it is fixed.
    const peeked = peekModel(bytes);
    const peekedModel = peeked === undefined ? undefined : findModel(deps.catalog, peeked);
    if (peekedModel) upstreamFor(peekedModel, baseUrl);
    // L3a: no model named -> the plan default; its group key is checked before the claim too.
    if (peeked === undefined && omitsModel(bytes)) {
      const fallback = await deps.db.getPlanDefaultModel((await deps.db.getPlan(userId)).plan);
      const fallbackModel = fallback === null ? undefined : findModel(deps.catalog, fallback);
      if (fallbackModel) upstreamFor(fallbackModel, baseUrl);
    }

    const claim = await deps.db.claimRequest(userId, key, await sha256Hex(bytes));
    if (claim !== "claimed") throw new HttpError(409, claim);

    const parsed = parseCompletionBody(bytes, req.headers.get("content-type") ?? "");
    const plan = await deps.db.getPlan(userId);
    // L3a: a request without a model runs on public.plans.default_model of the caller's plan
    // (none -> 400 model_required). A NAMED model is never replaced: one above the plan stays
    // 403 model_not_in_plan, unknown stays 404.
    let modelId = parsed.modelId;
    if (modelId === undefined) {
      const fallback = await deps.db.getPlanDefaultModel(plan.plan);
      if (fallback === null) throw new HttpError(400, "model_required");
      modelId = fallback;
      log({
        event: "model_router.plan_default",
        request_id: key,
        user_id: userId,
        plan: plan.plan,
        model: modelId,
      });
    }
    const listed = plan.allowedModels?.includes(modelId) ?? false;
    const model = findModel(deps.catalog, modelId);
    if (!model)
      throw new HttpError(listed ? 503 : 404, listed ? "model_not_configured" : "model_not_found");
    if (plan.allowedModels !== null && !listed) throw new HttpError(403, "model_not_in_plan");
    if (model.api !== "openai-completions") throw new HttpError(503, "provider_not_configured");
    const upstream = upstreamFor(model, baseUrl);
    const ignoredEffort = IGNORED_EFFORT_FIELDS.filter((field) => parsed.body[field] !== undefined);
    if (ignoredEffort.length > 0) {
      log({
        event: "model_router.effort_ignored",
        request_id: key,
        user_id: userId,
        model: model.id,
        fields: ignoredEffort,
      });
    }

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
    const reserved = Math.max(1, worstCaseCredits(model, promptTokens, maxTokens, markup));
    try {
      await deps.db.reserve(userId, key, reserved, limits.maxActive);
    } catch (error) {
      if (error instanceof ReserveError) {
        throw new HttpError(error.code === "too_many_requests" ? 429 : 402, error.code);
      }
      throw error;
    }

    return await forward({
      userId,
      key,
      model,
      parsed,
      upstream,
      markup,
      maxTokens,
      reserved,
      promptTokens,
      duration,
      deadline: startedAt + duration.maxDurationMs,
    });
  }

  type Ctx = {
    userId: string;
    key: string;
    model: CatalogModel;
    parsed: Parsed;
    upstream: UpstreamConfig;
    markup: Markup;
    maxTokens: number;
    reserved: number;
    promptTokens: number;
    duration: DurationLimits;
    /** Absolute end of the request budget (Date.now() based). */
    deadline: number;
  };

  const capped = (ctx: Ctx, credits: number) => Math.max(0, Math.min(credits, ctx.reserved));
  const int = (n: number) => Math.min(2147483647, Math.max(0, Math.floor(n)));

  /** usage, or the conservative estimate (prompt chars/4 + ceil(out chars/4 * 1.10)). */
  function usageOrEstimate(ctx: Ctx, usage: Usage | null, outputChars: number): Usage {
    return (
      usage ?? {
        promptTokens: ctx.promptTokens,
        cachedTokens: 0,
        completionTokens: estimateOutputTokens(outputChars),
      }
    );
  }

  /** router_store_cost: what the expiry sweep charges if this worker dies. */
  async function storeCost(ctx: Ctx, final: Usage, credits: number): Promise<boolean> {
    try {
      return await deps.db.storeCost({
        userId: ctx.userId,
        requestId: ctx.key,
        credits: capped(ctx, credits),
        model: ctx.model.id,
        provider: ctx.model.provider,
        inputTokens: int(final.promptTokens),
        outputTokens: int(final.completionTokens),
      });
    } catch {
      return false;
    }
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Settles the reservation: `release` = 0 credits (only when the upstream provably did
   * not accept the request); otherwise real usage, or the conservative estimate when
   * usage is missing (always capped at the reservation by settle_usage). settle_usage is
   * retried 2 times; if it still fails, the computed cost is stored on the
   * router_requests row so the expiry sweep charges it instead of refunding.
   */
  async function settle(
    ctx: Ctx,
    outcome: string,
    usage: Usage | null,
    outputChars: number,
    release = false,
    pending: Promise<unknown> = Promise.resolve(),
  ): Promise<void> {
    // A periodic cost store still in flight must not land after this settlement's own.
    await pending.catch(() => {});
    const estimated = !release && usage === null;
    const final: Usage = release
      ? { promptTokens: 0, cachedTokens: 0, completionTokens: 0 }
      : usageOrEstimate(ctx, usage, outputChars);
    const credits = release ? 0 : creditsFor(ctx.model, final, ctx.markup);
    const args = {
      userId: ctx.userId,
      requestId: ctx.key,
      credits,
      model: ctx.model.id,
      provider: ctx.model.provider,
      inputTokens: int(final.promptTokens),
      outputTokens: int(final.completionTokens),
    };
    const base = {
      outcome,
      request_id: ctx.key,
      user_id: ctx.userId,
      model: ctx.model.id,
      input_tokens: final.promptTokens,
      cached_tokens: final.cachedTokens,
      cache_write_tokens: final.cacheWriteTokens ?? 0,
      output_tokens: final.completionTokens,
      estimated,
      credits,
      reserved: ctx.reserved,
    };
    let lastError: unknown;
    for (let attempt = 0; attempt <= limits.settleRetries; attempt++) {
      if (attempt > 0) await sleep(limits.settleRetryDelayMs * attempt);
      try {
        // Release: first zero the cost stored before the fetch, so even if settle never
        // lands the sweep cannot charge a request the upstream rejected.
        // (best effort: a failure here must not stop the release itself).
        if (release) await deps.db.storeCost(args).catch(() => false);
        const result = await deps.db.settle(args);
        log({
          event: "model_router.settled",
          ...base,
          attempts: attempt + 1,
          charged: result.charged,
          code: result.code,
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    // Settle kept failing. Keep the cost for the expiry sweep (B4a release_expired_reservations
    // charges a stored cost, capped at the reservation); with nothing stored it refunds.
    const stored = release ? false : await storeCost(ctx, final, credits);
    log({
      event: "model_router.settle_failed",
      ...base,
      attempts: limits.settleRetries + 1,
      cost_stored: stored,
      error: lastError instanceof Error ? lastError.name : typeof lastError,
    });
  }

  /**
   * Billing rule: full release ONLY when the upstream provably did not take the request
   * (fetch failed without our own abort, or a non-2xx status). Anything after a 2xx, and
   * our own timeouts (headers timeout, total cap), pays real usage or the estimate.
   * Client disconnects never abort the upstream (it bills the full response anyway): the
   * work continues under waitUntil and settles with the final usage. request.signal is
   * not used at all (Deno.serve aborts it after a successful response too), so a
   * completed response is never classified as a disconnect.
   */
  async function forward(ctx: Ctx): Promise<Response> {
    // Progressive cost persistence, step 1, FAIL CLOSED: the minimum (prompt estimate,
    // capped) is stored BEFORE the upstream is called. If that store fails the sweep
    // could not charge a killed worker, so nothing goes upstream: release + 503.
    const promptOnly: Usage = {
      promptTokens: ctx.promptTokens,
      cachedTokens: 0,
      completionTokens: 0,
    };
    let storedCredits = capped(ctx, creditsFor(ctx.model, promptOnly, ctx.markup));
    if (!(await storeCost(ctx, promptOnly, storedCredits))) {
      log({
        event: "model_router.cost_store_failed",
        request_id: ctx.key,
        user_id: ctx.userId,
        phase: "prefetch",
      });
      await settle(ctx, "billing_unavailable", null, 0, true);
      return json(503, { error: "billing_unavailable" });
    }

    const abort = new AbortController();
    let ourAbort: string | undefined;
    const stop = (why: string) => {
      ourAbort ??= why;
      abort.abort(why);
    };
    // The cap counts from the request's arrival (MODUS_ROUTER_MAX_DURATION_MS), so the
    // whole request + settle fits the 150 s worker wall clock. The upstream always
    // streams, so both paths must see response headers within min(60 s, cap).
    const remaining = Math.max(0, ctx.deadline - Date.now());
    const cap = setTimeout(() => stop("stream_cap"), remaining);
    const headersMs = Math.min(ctx.duration.headersTimeoutMs, limits.headersTimeoutMs, remaining);
    const headersTimer = setTimeout(() => stop("upstream_timeout"), headersMs);
    const cleanup = () => {
      clearTimeout(cap);
      clearTimeout(headersTimer);
    };
    const request = buildOpenAiCompletionsRequest(
      ctx.model,
      ctx.parsed.body,
      ctx.maxTokens,
      ctx.upstream,
      abort.signal,
    );
    const timeoutResponse = () => json(504, { error: "upstream_timeout" });
    // Responses always name the Modus model id, never the gateway's model name.
    const reportedModel = { reported: ctx.model.id, upstream: ctx.model.upstreamId };

    // Step 2: while output arrives, the running estimate at most every
    // progressIntervalMs (stream AND non-stream). A killed worker leaves the last value
    // for the expiry sweep (capped at the reservation).
    let progress: Promise<unknown> = Promise.resolve();
    let lastProgressAt = Date.now();
    const onProgress = (usage: Usage | null, outputChars: number) => {
      const now = Date.now();
      if (now - lastProgressAt < limits.progressIntervalMs) return;
      lastProgressAt = now;
      const current = usageOrEstimate(ctx, usage, outputChars);
      const credits = capped(ctx, creditsFor(ctx.model, current, ctx.markup));
      if (credits <= storedCredits) return;
      storedCredits = credits;
      progress = progress.then(() => storeCost(ctx, current, credits));
      deps.waitUntil?.(progress);
    };

    /** Response headers, or a finished error Response (already settled). */
    async function open(): Promise<Response | { error: Response }> {
      let response: Response;
      try {
        response = await fetchImpl(request.url, request.init);
      } catch {
        cleanup();
        if (ourAbort) {
          // Sent, then our timeout: the upstream may have taken it -> estimate.
          await settle(ctx, ourAbort, null, 0);
          return { error: timeoutResponse() };
        }
        await settle(ctx, "upstream_unreachable", null, 0, true);
        return { error: json(502, { error: "upstream_error" }) };
      }
      clearTimeout(headersTimer);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        cleanup();
        await settle(ctx, "upstream_status", null, 0, true);
        return { error: json(502, { error: "upstream_error", upstream_status: response.status }) };
      }
      if (!response.body) {
        cleanup();
        await settle(ctx, "upstream_error", null, 0);
        return { error: json(502, { error: "upstream_error" }) };
      }
      return response;
    }

    if (!ctx.parsed.stream) {
      const work = (async (): Promise<Response> => {
        const opened = await open();
        if (!(opened instanceof Response) || !opened.body) {
          return opened instanceof Response ? json(502, { error: "upstream_error" }) : opened.error;
        }
        const assembler = new CompletionAssembler(ctx.model.id);
        const tracker = new SseUsageTracker(assembler, reportedModel);
        const reader = opened.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            tracker.push(chunk.value);
            onProgress(tracker.usage, tracker.outputChars);
          }
        } catch {
          // Cap, or the upstream failed mid-body: real usage if it came, else the
          // estimate of the prompt + every output character received so far.
          cleanup();
          tracker.end();
          const outcome = ourAbort ?? "upstream_error";
          await settle(ctx, outcome, tracker.usage, tracker.outputChars, false, progress);
          return ourAbort ? timeoutResponse() : json(502, { error: "upstream_error" });
        }
        cleanup();
        tracker.end();
        await settle(ctx, "complete", tracker.usage, tracker.outputChars, false, progress);
        return new Response(tracker.jsonBody ?? JSON.stringify(assembler.result()), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      })();
      // If the client goes away, the runtime keeps this alive until it has settled.
      deps.waitUntil?.(work);
      return await work;
    }

    const opened = await open();
    if (!(opened instanceof Response) || !opened.body) {
      return opened instanceof Response ? json(502, { error: "upstream_error" }) : opened.error;
    }

    const tracker = new SseUsageTracker(undefined, reportedModel);
    const reader = opened.body.getReader();
    let clientGone = false;
    let settled: Promise<void> | undefined;
    const finish = (outcome: string) => {
      settled ??= (async () => {
        cleanup();
        tracker.end();
        await settle(ctx, outcome, tracker.usage, tracker.outputChars, false, progress);
      })();
      deps.waitUntil?.(settled);
      return settled;
    };
    // After a disconnect: keep reading the upstream (bounded by the cap) for the final usage.
    const drain = async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          tracker.push(chunk.value);
          onProgress(tracker.usage, tracker.outputChars);
        }
        await finish("client_disconnect");
      } catch {
        await finish(ourAbort ?? "upstream_error");
      }
    };

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Read until there are complete (rewritten) lines to forward, or the end.
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            if (clientGone) return; // drain() settles
            const tail = tracker.end();
            await finish(ourAbort ?? "upstream_error");
            if (tail.byteLength > 0) controller.enqueue(tail);
            controller.error(new Error("upstream stream failed"));
            return;
          }
          const out = chunk.done ? tracker.end() : tracker.push(chunk.value);
          if (!chunk.done) onProgress(tracker.usage, tracker.outputChars);
          if (clientGone) return; // drain() owns the rest
          if (chunk.done) {
            // Settle before closing so the runtime keeps the request alive for it.
            await finish("complete");
            if (out.byteLength > 0) controller.enqueue(out);
            controller.close();
            return;
          }
          if (out.byteLength > 0) {
            controller.enqueue(out);
            return;
          }
        }
      },
      cancel() {
        clientGone = true;
        const draining = drain();
        deps.waitUntil?.(draining);
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
    const startedAt = Date.now();
    try {
      const route = ROUTE.exec(new URL(req.url).pathname)?.[1];
      if (!route) throw new HttpError(404, "not_found");
      const method = route === "/v1/models" ? "GET" : "POST";
      if (req.method !== method) throw new HttpError(405, "method_not_allowed");
      const user = await deps.getUser(req);
      if (!user) throw new HttpError(401, "unauthorized");
      return route === "/v1/models"
        ? await listModels(user.id)
        : await completion(req, user.id, startedAt);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
