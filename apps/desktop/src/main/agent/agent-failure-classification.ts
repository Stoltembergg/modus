import type {
  AgentFailureCode,
  AgentFailureMetadata,
  AgentFailurePhase,
} from "../../shared/contracts";

export function classifyAgentFailure(input: {
  providerStatus?: number;
  providerCode?: string;
  providerRetryAfterMs?: number;
  finishReason?: string;
  hadToolCalls: boolean;
  failurePhase: AgentFailurePhase;
}): { code: AgentFailureCode; retryable: boolean; safeToRetry: boolean; retryAfterMs?: number } {
  const providerCode = input.providerCode?.toLowerCase();
  let code: AgentFailureCode = "unknown";
  if (
    input.providerStatus === 401 ||
    input.providerStatus === 403 ||
    ["invalid_api_key", "authentication_error", "permission_denied", "unauthorized"].includes(
      providerCode ?? "",
    )
  ) {
    code = "provider_auth";
  } else if (
    [
      "model_not_found",
      "unsupported_model",
      "unsupported_reasoning",
      "invalid_reasoning_effort",
      "unsupported_parameter",
    ].includes(providerCode ?? "")
  ) {
    code = "model_configuration";
  } else if (
    input.providerStatus === 429 ||
    ["rate_limit_exceeded", "rate_limit_error", "too_many_requests"].includes(providerCode ?? "")
  ) {
    code = "provider_rate_limited";
  } else if (
    (input.providerStatus !== undefined &&
      Number.isInteger(input.providerStatus) &&
      input.providerStatus >= 500 &&
      input.providerStatus <= 599) ||
    ["overloaded_error", "server_error", "service_unavailable", "internal_server_error"].includes(
      providerCode ?? "",
    )
  ) {
    code = "provider_unavailable";
  } else if (input.failurePhase === "tool") {
    code = "tool_failure";
  } else if (input.finishReason === "empty_assistant_output") {
    code = "empty_assistant_output";
  }
  const retryable = code === "provider_rate_limited" || code === "provider_unavailable";
  const timing = input.providerRetryAfterMs;
  const validTiming =
    timing !== undefined && Number.isFinite(timing) && timing >= 1000 && timing <= 60000;
  const safeTiming = timing === undefined ? code !== "provider_rate_limited" : validTiming;
  return {
    code,
    retryable,
    safeToRetry: retryable && !input.hadToolCalls && safeTiming,
    ...(validTiming ? { retryAfterMs: timing } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Only structured SDK fields enter the classifier. Raw messages/payloads never leave this boundary. */
export function agentFailureFromMetadata(
  source: unknown,
  context: { hadToolCalls: boolean; failurePhase: AgentFailurePhase; finishReason?: string },
): AgentFailureMetadata & { failureCode: AgentFailureCode } {
  const raw = record(source);
  const error = record(raw.error);
  const status = raw.providerStatus ?? raw.status ?? raw.statusCode ?? error.status;
  const code = raw.providerCode ?? raw.code ?? error.code ?? error.type;
  const finish = context.finishReason ?? raw.finishReason ?? raw.stopReason;
  const retryTiming = raw.providerRetryAfterMs ?? raw.retryAfterMs ?? error.retryAfterMs;
  const headers = record(raw.headers);
  const retryHeader = headers["retry-after"];
  const providerRetryAfterMs =
    retryTiming !== undefined
      ? typeof retryTiming === "number"
        ? retryTiming
        : Number.NaN
      : retryHeader !== undefined
        ? typeof retryHeader === "string" && /^\d+(?:\.\d+)?$/.test(retryHeader.trim())
          ? Number(retryHeader) * 1000
          : Number.NaN
        : undefined;
  const result = classifyAgentFailure({
    ...context,
    ...(typeof status === "number" ? { providerStatus: status } : {}),
    ...(typeof code === "string" ? { providerCode: code } : {}),
    ...(typeof finish === "string" ? { finishReason: finish } : {}),
    ...(providerRetryAfterMs !== undefined ? { providerRetryAfterMs } : {}),
  });
  return {
    failureCode: result.code,
    failurePhase: context.failurePhase,
    hadToolCalls: context.hadToolCalls,
    retryable: result.retryable,
    safeToRetry: result.safeToRetry,
    ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
  };
}

/** Fixed, actionable copy avoids credential-bearing URLs, headers and raw provider errors. */
export function agentFailureDiagnostic(code: AgentFailureCode): string {
  switch (code) {
    case "provider_auth":
      return "Provider authentication failed. Check the API credentials and access.";
    case "provider_rate_limited":
      return "The provider rate limit was reached. Wait before trying again.";
    case "provider_unavailable":
      return "The provider is unavailable. Try again shortly.";
    case "model_configuration":
      return "The model configuration is unsupported. Check the model, API type and reasoning settings.";
    case "empty_assistant_output":
      return "The selected model finished without returning any assistant output. Check the model, API type and reasoning settings.";
    case "tool_failure":
      return "A tool failed. Check its configuration before trying again.";
    default:
      return "The agent turn failed. Try again or check the provider settings.";
  }
}
