import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
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

const COMMAND_CODE_URL = "https://api.commandcode.ai/alpha/generate";
const REQUEST_TIMEOUT_MS = 120_000;
const CLIENT_IDENTITY = "Modus";

export interface CommandCodeInput {
  modelId: string;
  systemPrompt?: string;
  messages: Array<{ role: string; content: unknown }>;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
}

interface CommandCodeRequestBody {
  config: Record<string, unknown>;
  memory: Record<string, unknown>;
  taste: Record<string, unknown>;
  skills: unknown[];
  permissionMode: string;
  params: Record<string, unknown>;
}

export interface CommandCodeRequest {
  url: string;
  headers: Record<string, string>;
  body: CommandCodeRequestBody;
}

export function buildCommandCodeRequest(
  input: CommandCodeInput,
  credentials: { apiKey: string; sessionId?: string },
): CommandCodeRequest {
  const config: Record<string, unknown> = {};
  if (input.systemPrompt !== undefined) config.systemPrompt = input.systemPrompt;
  const memory: Record<string, unknown> = {};
  if (credentials.sessionId) memory.sessionId = credentials.sessionId;
  const params: Record<string, unknown> = {
    model: input.modelId,
    stream: true,
    messages: input.messages,
    tools: input.tools,
  };
  if (input.maxTokens !== undefined) params.maxTokens = input.maxTokens;
  if (input.temperature !== undefined) params.temperature = input.temperature;
  if (input.topP !== undefined) params.topP = input.topP;
  if (input.topK !== undefined) params.topK = input.topK;
  return {
    url: COMMAND_CODE_URL,
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      "Content-Type": "application/json",
      "x-project-slug": "modus",
      "x-client-name": CLIENT_IDENTITY,
    },
    body: { config, memory, taste: {}, skills: [], permissionMode: "default", params },
  };
}

export type CommandCodeEvent = Record<string, unknown> & { type: string };

export async function* parseCommandCodeEvents(response: Response): AsyncGenerator<CommandCodeEvent> {
  if (!response.ok) throw new Error(`Command Code request failed (${response.status})`);
  if (!response.body) throw new Error("Command Code response did not include a stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parseLine = (line: string): CommandCodeEvent | "done" | undefined => {
    if (!line.startsWith("data:")) return undefined;
    const data = line.slice(5).replace(/^ /, "");
    if (data === "[DONE]") return "done";
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
      throw new Error("Malformed Command Code event");
    }
    return value as CommandCodeEvent;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseLine(line);
        if (event === "done") return;
        if (event) yield event;
      }
      if (done) break;
    }
    if (buffer) {
      const event = parseLine(buffer);
      if (event && event !== "done") yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

const emptyUsage = (): Usage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistant(modelId: string, content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant", content, api: "commandcode-alpha-generate", provider: "commandcode",
    model: modelId, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now(),
  };
}

function errorTerminal(modelId: string, message: string, reason: "error" | "aborted" = "error"): AssistantMessageEvent {
  const error: AssistantMessage = { ...assistant(modelId), stopReason: reason, errorMessage: message };
  return { type: "error", reason, error };
}

export async function* mapCommandCodeResponse(response: Response, modelId: string): AsyncGenerator<AssistantMessageEvent> {
  let message = assistant(modelId);
  let started = false;
  let terminal = false;
  const start = (): AssistantMessageEvent => ({ type: "start", partial: message });
  try {
    for await (const event of parseCommandCodeEvents(response)) {
      if (!started) { started = true; yield start(); }
      const type = event.type;
      const delta = typeof event.delta === "string" ? event.delta : typeof event.text === "string" ? event.text : "";
      if (type === "text-delta" || type === "text") {
        if (!delta) continue;
        const contentIndex = message.content.findIndex((part) => part.type === "text");
        if (contentIndex < 0) {
          message = { ...message, content: [...message.content, { type: "text", text: delta }] };
          yield { type: "text_start", contentIndex: message.content.length - 1, partial: message };
          yield { type: "text_delta", contentIndex: message.content.length - 1, delta, partial: message };
        } else {
          const previous = message.content[contentIndex];
          if (previous.type === "text") {
            message = { ...message, content: message.content.map((part, index) => index === contentIndex ? { ...part, text: part.text + delta } : part) };
            yield { type: "text_delta", contentIndex, delta, partial: message };
          }
        }
      } else if (type === "reasoning-delta" || type === "reasoning") {
        if (!delta) continue;
        const contentIndex = message.content.findIndex((part) => part.type === "thinking");
        if (contentIndex < 0) {
          message = { ...message, content: [...message.content, { type: "thinking", thinking: delta }] };
          yield { type: "thinking_start", contentIndex: message.content.length - 1, partial: message };
          yield { type: "thinking_delta", contentIndex: message.content.length - 1, delta, partial: message };
        } else {
          const previous = message.content[contentIndex];
          if (previous.type === "thinking") {
            message = { ...message, content: message.content.map((part, index) => index === contentIndex ? { ...part, thinking: part.thinking + delta } : part) };
            yield { type: "thinking_delta", contentIndex, delta, partial: message };
          }
        }
      } else if (type === "tool-call" || type === "tool-input" || type === "tool-input-delta") {
        const id = String(event.toolCallId ?? event.id ?? `tool-${message.content.length}`);
        const name = typeof event.name === "string" ? event.name : "";
        const argsRaw = event.arguments ?? event.input ?? "{}";
        let args: Record<string, unknown> = {};
        if (typeof argsRaw === "string") {
          try { const parsed: unknown = JSON.parse(argsRaw); if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>; } catch { /* incomplete tool-input deltas are retained by later full calls */ }
        } else if (argsRaw && typeof argsRaw === "object") args = argsRaw as Record<string, unknown>;
        const existing = message.content.findIndex((part) => part.type === "toolCall" && part.id === id);
        const toolCall = { type: "toolCall" as const, id, name, arguments: args };
        if (existing < 0) message = { ...message, content: [...message.content, toolCall] };
        else message = { ...message, content: message.content.map((part, index) => index === existing ? toolCall : part) };
        yield { type: "toolcall_end", contentIndex: existing < 0 ? message.content.length - 1 : existing, toolCall, partial: message };
      } else if (type === "usage" || type === "finish-step") {
        const usage = event.usage;
        if (usage && typeof usage === "object") {
          const record = usage as Record<string, unknown>;
          const input = Number(record.inputTokens ?? record.input ?? 0) || 0;
          const output = Number(record.outputTokens ?? record.output ?? 0) || 0;
          message = { ...message, usage: { ...message.usage, input, output, totalTokens: Number(record.totalTokens ?? input + output) || input + output } };
        }
        if (type === "finish-step") {
          const reason = event.finishReason === "length" ? "length" : event.finishReason === "tool-calls" || event.finishReason === "toolUse" ? "toolUse" : "stop";
          message = { ...message, stopReason: reason };
          terminal = true;
          yield { type: "done", reason, message };
          return;
        }
      } else if (type === "error") {
        terminal = true;
        yield errorTerminal(modelId, typeof event.message === "string" ? event.message : "Command Code returned an error");
        return;
      }
    }
    if (!terminal) yield errorTerminal(modelId, "Command Code stream ended before finish-step");
  } catch (error) {
    yield errorTerminal(modelId, error instanceof Error ? error.message : "Command Code stream failed");
  }
}

function piContentToText(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const value = part as Record<string, unknown>;
    if (value.type === "image") return [];
    if (value.type === "text") return [{ type: "text", text: value.text }];
    if (value.type === "thinking") return [{ type: "reasoning", text: value.thinking }];
    if (value.type === "toolCall") return [{ type: "tool-call", id: value.id, name: value.name, arguments: value.arguments }];
    return [];
  });
}

function contextInput(model: Model<Api>, context: Context, options?: SimpleStreamOptions): CommandCodeInput {
  const params: CommandCodeInput = {
    modelId: model.id,
    systemPrompt: context.systemPrompt,
    messages: context.messages.map((message) => ({ role: message.role, content: piContentToText(message.content) })),
    tools: (context.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as Record<string, unknown>,
    })),
  };
  if (options?.maxTokens !== undefined) params.maxTokens = options.maxTokens;
  if (options?.temperature !== undefined) params.temperature = options.temperature;
  return params;
}

export const commandCodeStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const controller = new AbortController();
    const abort = () => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (options?.signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error("Command Code request timed out")),
      Math.min(Math.max(options?.timeoutMs ?? REQUEST_TIMEOUT_MS, 1), REQUEST_TIMEOUT_MS));
    try {
      const key = options?.apiKey;
      if (!key) throw new Error("Command Code API key is missing");
      let request = buildCommandCodeRequest(contextInput(model, context, options), { apiKey: key, sessionId: options?.sessionId });
      if (options?.headers) {
        for (const [name, value] of Object.entries(options.headers)) {
          if (name.toLowerCase() === "authorization") continue;
          if (value === null) delete request.headers[name];
          else request.headers[name] = value;
        }
      }
      const replacement = await options?.onPayload?.(request.body, model);
      if (replacement && typeof replacement === "object") request = { ...request, body: replacement as CommandCodeRequestBody };
      const response = await fetch(request.url, {
        method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal,
      });
      await options?.onResponse?.({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      }, model);
      if (!response.ok) throw new Error(`Command Code request failed (${response.status})`);
      for await (const event of mapCommandCodeResponse(response, model.id)) stream.push(event);
    } catch (error) {
      const aborted = controller.signal.aborted;
      stream.push(errorTerminal(model.id, aborted ? "Command Code request was cancelled or timed out" : error instanceof Error ? error.message : "Command Code request failed", aborted ? "aborted" : "error"));
    } finally {
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abort);
      stream.end();
    }
  })();
  return stream;
};
