import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_API_ID, antigravityModels } from "./native-provider-manifest";

const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const MODEL_BY_ID = new Map(antigravityModels.map((model) => [model.id, model]));

export interface AntigravityInput {
  modelId: string;
  systemPrompt?: string;
  messages: Array<{
    role: string;
    content: unknown;
    provider?: unknown;
    model?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
  }>;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  thinkingLevel?: string;
  thinkingBudget?: number;
}

export interface AntigravityCredentials {
  accessToken: string;
  projectId: string | null;
}
export interface AntigravityRequest {
  url: string;
  route: "antigravity" | "gemini-cli";
  headers: Record<string, string>;
  body: {
    project: string | null;
    model: string;
    request: Record<string, unknown>;
    requestType?: "agent";
    userAgent?: "antigravity";
    requestId?: string;
  };
}

const WIRE_MODEL_BY_ID: Record<string, string> = {
  "antigravity-gemini-3-pro": "gemini-3-pro-low",
  "antigravity-gemini-3.1-pro": "gemini-3.1-pro-low",
  "antigravity-gemini-3-flash": "gemini-3-flash",
  "antigravity-claude-sonnet-4-6": "claude-sonnet-4-6",
  "antigravity-claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
};

function wireModelId(modelId: string, thinkingLevel: string | undefined): string {
  if (thinkingLevel?.toLowerCase() === "high") {
    if (modelId === "antigravity-gemini-3-pro") return "gemini-3-pro-high";
    if (modelId === "antigravity-gemini-3.1-pro") return "gemini-3.1-pro-high";
  }
  return WIRE_MODEL_BY_ID[modelId] ?? modelId;
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type.toUpperCase() : undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj))
    result[key] = key === "type" && type ? type : normalizeSchema(child);
  return result;
}

function mapContent(content: unknown, replaySignatures: boolean): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap<Record<string, unknown>>((part): Record<string, unknown>[] => {
    if (!part || typeof part !== "object") return [];
    const value = part as Record<string, unknown>;
    if (value.type === "text")
      return [
        {
          text: value.text,
          ...(replaySignatures && value.textSignature
            ? { thoughtSignature: value.textSignature }
            : {}),
        },
      ];
    if (value.type === "thinking")
      return [
        {
          text: value.thinking,
          thought: true,
          ...(replaySignatures && value.thinkingSignature
            ? { thoughtSignature: value.thinkingSignature }
            : {}),
        },
      ];
    if (value.type === "image")
      return [{ inlineData: { mimeType: value.mimeType ?? "image/jpeg", data: value.data } }];
    if (value.type === "toolCall")
      return [
        {
          functionCall: { id: value.id, name: value.name, args: value.arguments },
          ...(replaySignatures && value.thoughtSignature
            ? { thoughtSignature: value.thoughtSignature }
            : {}),
        },
      ];
    return [];
  });
}

function mapToolResult(message: {
  content: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
}): Array<Record<string, unknown>> {
  const text = Array.isArray(message.content)
    ? message.content
        .flatMap((part) => {
          if (!part || typeof part !== "object") return [];
          const value = part as Record<string, unknown>;
          return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
        })
        .join("\n")
    : "";
  return [
    {
      functionResponse: {
        id: message.toolCallId,
        name: message.toolName,
        response: { result: text },
      },
    },
  ];
}

function reasoningOptions(
  input: AntigravityInput,
  claude: boolean,
): Record<string, unknown> | undefined {
  if (claude) {
    if (input.modelId !== "antigravity-claude-opus-4-6-thinking") return undefined;
    const budget = input.thinkingLevel === "max" ? 32768 : input.thinkingBudget;
    if (!budget) return undefined;
    return { include_thoughts: true, thinking_budget: budget };
  }
  const level = input.thinkingLevel?.toLowerCase();
  return level && ["minimal", "low", "medium", "high"].includes(level)
    ? { thinkingLevel: level }
    : undefined;
}

export function buildAntigravityRequest(
  input: AntigravityInput,
  credentials: AntigravityCredentials,
): AntigravityRequest {
  const model = MODEL_BY_ID.get(input.modelId);
  if (!model?.quotaRoute) throw new Error("Unsupported Antigravity model");
  if (!credentials.accessToken) throw new Error("Antigravity access token is missing");
  if (model.quotaRoute === "gemini-cli" && !credentials.projectId)
    throw new Error("A discovered Cloud project is required for this model");
  const claude = input.modelId.startsWith("antigravity-claude-");
  const request: Record<string, unknown> = {
    contents: input.messages
      .filter(
        (message) =>
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "model" ||
          message.role === "tool" ||
          message.role === "toolResult",
      )
      .map((message) => ({
        role: message.role === "assistant" || message.role === "model" ? "model" : "user",
        parts:
          message.role === "toolResult"
            ? mapToolResult(
                message as { content: unknown; toolCallId?: unknown; toolName?: unknown },
              )
            : mapContent(
                message.content,
                message.role === "assistant" &&
                  message.provider === "antigravity" &&
                  message.model === input.modelId,
              ),
      })),
  };
  if (input.systemPrompt) request.systemInstruction = { parts: [{ text: input.systemPrompt }] };
  if (input.tools.length) {
    request.tools = [
      {
        functionDeclarations: input.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: normalizeSchema(tool.inputSchema),
        })),
      },
    ];
    if (claude) request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: claude
      ? Math.max(input.maxTokens ?? 0, 64000)
      : (input.maxTokens ?? model.maxOutputTokens),
  };
  if (input.temperature !== undefined) generationConfig.temperature = input.temperature;
  if (input.topP !== undefined) generationConfig.topP = input.topP;
  const thinkingConfig = reasoningOptions(input, claude);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  request.generationConfig = generationConfig;
  const route = model.quotaRoute;
  const endpoint = route === "antigravity" ? ANTIGRAVITY_ENDPOINT : GEMINI_CLI_ENDPOINT;
  return {
    route,
    url: `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      "content-type": "application/json",
      "user-agent": "Modus",
    },
    body: {
      project: credentials.projectId,
      model: wireModelId(input.modelId, input.thinkingLevel),
      request,
      ...(route === "antigravity"
        ? { requestType: "agent", userAgent: "antigravity", requestId: `agent-${randomUUID()}` }
        : {}),
    },
  };
}

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
function emptyMessage(modelId: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: ANTIGRAVITY_API_ID,
    provider: "antigravity",
    model: modelId,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
function errorEvent(modelId: string, reason: string, aborted = false): AssistantMessageEvent {
  const error: AssistantMessage = {
    ...emptyMessage(modelId),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: reason,
  };
  return { type: "error", reason: aborted ? "aborted" : "error", error };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function updateUsage(message: AssistantMessage, raw: unknown): AssistantMessage {
  const usage = record(raw);
  if (!Object.keys(usage).length) return message;
  const input = Number(usage.promptTokenCount ?? usage.inputTokens ?? 0) || 0;
  const output = Number(usage.candidatesTokenCount ?? usage.outputTokens ?? 0) || 0;
  return {
    ...message,
    usage: {
      ...message.usage,
      input,
      output,
      totalTokens: Number(usage.totalTokenCount ?? input + output) || input + output,
    },
  };
}

export async function* mapAntigravityResponse(
  response: Response,
  modelId: string,
): AsyncGenerator<AssistantMessageEvent> {
  let message = emptyMessage(modelId);
  const begin = (): AssistantMessageEvent => ({ type: "start", partial: message });
  const fail = (text: string) => errorEvent(modelId, text);
  try {
    if (!response.ok) throw new Error(`Antigravity request failed (${response.status})`);
    const handle = (value: unknown): AssistantMessageEvent[] => {
      const root = record(value);
      if (root.error || root.type === "error") return [fail("Antigravity returned an error")];
      const envelope = record(root.response ?? root);
      const candidate = record(
        Array.isArray(envelope.candidates) ? envelope.candidates[0] : envelope.candidate,
      );
      const content = record(candidate.content ?? envelope.content);
      const emitted: AssistantMessageEvent[] = [];
      for (const raw of Array.isArray(content.parts) ? content.parts : []) {
        const part = record(raw);
        const signature =
          typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
        const text =
          typeof part.text === "string"
            ? part.text
            : typeof part.thinking === "string"
              ? part.thinking
              : undefined;
        if (text !== undefined) {
          const thinking = part.thought === true || typeof part.thinking === "string";
          const contentIndex = message.content.length;
          message = {
            ...message,
            content: [
              ...message.content,
              thinking
                ? {
                    type: "thinking",
                    thinking: text,
                    ...(signature ? { thinkingSignature: signature } : {}),
                  }
                : { type: "text", text, ...(signature ? { textSignature: signature } : {}) },
            ] as AssistantMessage["content"],
          };
          emitted.push(
            thinking
              ? { type: "thinking_start", contentIndex, partial: message }
              : { type: "text_start", contentIndex, partial: message },
          );
          emitted.push(
            thinking
              ? { type: "thinking_delta", contentIndex, delta: text, partial: message }
              : { type: "text_delta", contentIndex, delta: text, partial: message },
          );
        }
        const call = record(part.functionCall);
        if (typeof call.name === "string") {
          const toolCall = {
            type: "toolCall" as const,
            id: String(call.id ?? `call-${message.content.length}`),
            name: call.name,
            arguments: record(call.args),
            ...(signature ? { thoughtSignature: signature } : {}),
          };
          const contentIndex = message.content.length;
          message = { ...message, content: [...message.content, toolCall] };
          emitted.push({ type: "toolcall_start", contentIndex, partial: message });
          emitted.push({
            type: "toolcall_delta",
            contentIndex,
            delta: JSON.stringify(toolCall.arguments),
            partial: message,
          });
          emitted.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
        }
      }
      message = updateUsage(message, envelope.usageMetadata ?? envelope.usage);
      const reason = candidate.finishReason ?? envelope.finishReason ?? envelope.stopReason;
      if (reason) {
        const stopReason =
          reason === "MAX_TOKENS" || reason === "length"
            ? "length"
            : message.content.some((part) => part.type === "toolCall")
              ? "toolUse"
              : "stop";
        message = { ...message, stopReason };
        emitted.push({ type: "done", reason: stopReason, message });
      }
      return emitted;
    };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      yield begin();
      const events = handle(await response.json());
      if (events.some((event) => event.type === "done" || event.type === "error")) {
        yield* events;
      } else yield fail("Antigravity response did not include a finish reason");
      return;
    }
    if (!response.body) throw new Error("Antigravity response stream is unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sentStart = false;
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const value: unknown = JSON.parse(data);
          if (!sentStart) {
            sentStart = true;
            yield begin();
          }
          const events = handle(value);
          yield* events;
          if (events.some((event) => event.type === "done" || event.type === "error")) return;
        }
        if (chunk.done) break;
      }
      if (buffer.startsWith("data:")) {
        const data = buffer.slice(5).trim();
        if (data && data !== "[DONE]") {
          if (!sentStart) yield begin();
          const events = handle(JSON.parse(data));
          yield* events;
          if (events.some((event) => event.type === "done" || event.type === "error")) return;
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield fail("Antigravity stream ended before completion");
  } catch {
    yield fail("Antigravity response could not be processed");
  }
}

function piInput(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AntigravityInput {
  return {
    modelId: model.id,
    ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
    messages: context.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.role === "assistant" ? { provider: message.provider, model: message.model } : {}),
      ...(message.role === "toolResult"
        ? {
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            isError: message.isError,
          }
        : {}),
    })),
    tools: (context.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as Record<string, unknown>,
    })),
    ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.reasoning ? { thinkingLevel: options.reasoning } : {}),
    ...(options?.reasoning &&
    options.reasoning !== "xhigh" &&
    options.reasoning !== "max" &&
    options.thinkingBudgets?.[options.reasoning] !== undefined
      ? { thinkingBudget: options.thinkingBudgets[options.reasoning] }
      : {}),
  };
}

export function createAntigravityStream(deps: {
  credentials: () => AntigravityCredentials | null;
  fetch?: typeof fetch;
}) {
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (options?.signal?.aborted) throw new Error("abort");
        const credentials = deps.credentials();
        if (!credentials) throw new Error("credentials");
        const request = buildAntigravityRequest(piInput(model, context, options), credentials);
        const response = await (deps.fetch ?? globalThis.fetch)(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: controller.signal,
        });
        if (options?.onResponse)
          await options.onResponse(
            { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
            model,
          );
        if (!response.ok) {
          stream.push(errorEvent(model.id, `Antigravity request failed (${response.status})`));
        } else {
          for await (const event of mapAntigravityResponse(response, model.id)) stream.push(event);
        }
      } catch {
        stream.push(
          errorEvent(
            model.id,
            "Antigravity request failed",
            controller.signal.aborted || options?.signal?.aborted,
          ),
        );
      } finally {
        options?.signal?.removeEventListener("abort", onAbort);
        stream.end();
      }
    })();
    return stream;
  };
}

/** Registry wiring supplies the current OAuth-backed access token and discovered project ID. */
let activeCredentials: AntigravityCredentials | null = null;
export function setAntigravityCredentials(credentials: AntigravityCredentials | null): void {
  activeCredentials = credentials;
}
export const antigravityStream = createAntigravityStream({ credentials: () => activeCredentials });
