import { describe, expect, it } from "vitest";
import { classifyAgentFailure } from "./agent-failure-classification";

const base = { hadToolCalls: false, failurePhase: "provider" as const };
describe("classifyAgentFailure", () => {
  it.each([
    [{ providerStatus: 401 }, "provider_auth", false, false],
    [{ providerStatus: 403 }, "provider_auth", false, false],
    [{ providerStatus: 429 }, "provider_rate_limited", true, false],
    [{ providerStatus: 429, providerRetryAfterMs: 1000 }, "provider_rate_limited", true, true],
    [{ providerStatus: 503 }, "provider_unavailable", true, true],
    [{ providerStatus: 500 }, "provider_unavailable", true, true],
    [{ providerCode: "invalid_api_key" }, "provider_auth", false, false],
    [{ providerCode: "rate_limit_exceeded" }, "provider_rate_limited", true, false],
    [{ providerCode: "overloaded_error" }, "provider_unavailable", true, true],
    [{ providerCode: "model_not_found" }, "model_configuration", false, false],
    [{ providerCode: "unsupported_model" }, "model_configuration", false, false],
    [{ providerCode: "unsupported_reasoning" }, "model_configuration", false, false],
    [{ providerCode: "invalid_reasoning_effort" }, "model_configuration", false, false],
    [
      { finishReason: "empty_assistant_output", failurePhase: "finalize" },
      "empty_assistant_output",
      false,
      false,
    ],
    [{ failurePhase: "tool" }, "tool_failure", false, false],
    [{ providerStatus: 400 }, "unknown", false, false],
    [{ providerCode: "a_new_provider_code" }, "unknown", false, false],
    [{}, "unknown", false, false],
  ])("classifies structured metadata %j", (input, code, retryable, safeToRetry) => {
    expect(
      classifyAgentFailure({ ...base, ...input } as Parameters<typeof classifyAgentFailure>[0]),
    ).toMatchObject({ code, retryable, safeToRetry });
  });
  it.each([
    "401 invalid API key",
    "429 rate limit",
    "503 overloaded",
    "unsupported model reasoning",
  ])("does not classify prose %s", (message) => {
    expect(
      classifyAgentFailure({ ...base, message } as Parameters<typeof classifyAgentFailure>[0]),
    ).toEqual({ code: "unknown", retryable: false, safeToRetry: false });
  });
  it.each([
    0,
    -1,
    999,
    60001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("keeps malformed or unbounded timing %s manual", (providerRetryAfterMs) => {
    expect(classifyAgentFailure({ ...base, providerStatus: 429, providerRetryAfterMs })).toEqual({
      code: "provider_rate_limited",
      retryable: true,
      safeToRetry: false,
    });
    expect(
      classifyAgentFailure({ ...base, providerStatus: 503, providerRetryAfterMs }).safeToRetry,
    ).toBe(false);
  });
  it.each([1000, 60000])("preserves bounded structured timing %s", (providerRetryAfterMs) => {
    expect(classifyAgentFailure({ ...base, providerStatus: 429, providerRetryAfterMs })).toEqual({
      code: "provider_rate_limited",
      retryable: true,
      safeToRetry: true,
      retryAfterMs: providerRetryAfterMs,
    });
  });
  it.each([429, 503])("never marks a transient failure after tools safe (%s)", (providerStatus) => {
    expect(
      classifyAgentFailure({
        ...base,
        providerStatus,
        providerRetryAfterMs: 1000,
        hadToolCalls: true,
      }).safeToRetry,
    ).toBe(false);
  });
  it("keeps empty output after tools manual, while independent transient metadata takes precedence", () => {
    expect(
      classifyAgentFailure({
        ...base,
        hadToolCalls: true,
        finishReason: "empty_assistant_output",
        failurePhase: "finalize",
      }),
    ).toEqual({ code: "empty_assistant_output", retryable: false, safeToRetry: false });
    expect(
      classifyAgentFailure({
        ...base,
        providerStatus: 503,
        finishReason: "empty_assistant_output",
        failurePhase: "finalize",
      }).code,
    ).toBe("provider_unavailable");
  });
});
