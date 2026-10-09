import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "./harness/feature-flags";
import { HarnessObserver } from "./harness/observability/harness-observer";
import { createModusCompactionExtension } from "./pi-compaction-extension";

type CapturedHandler = (event: unknown, context: unknown) => unknown;

function duplicateReadMessages() {
  const text = "export interface ContextFixture { readonly item: string; }\n".repeat(80);
  return [
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "read-first",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "read-later",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 2,
    },
  ];
}

function captureHandlers() {
  const handlers = new Map<string, CapturedHandler>();
  const on = (event: string, handler: unknown): void => {
    handlers.set(event, handler as CapturedHandler);
  };
  return { handlers, on };
}

describe("Pi SDK compaction context extension", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    HarnessObserver.resetInstance();
    setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_COMPACTION_PRUNING: true });
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    HarnessObserver.resetInstance();
  });

  it("registers only the context hook and never intercepts native compaction", () => {
    const { handlers, on } = captureHandlers();
    const factory = createModusCompactionExtension(() => undefined);

    factory({ on } as never);

    expect([...handlers.keys()]).toEqual(["context"]);
  });

  it("prunes only with a current scope and records safe metrics", async () => {
    const observer = HarnessObserver.getInstance();
    const observerSessionToken = observer.beginSession("scope-session");
    const recordPruning = vi.spyOn(observer, "recordCompactionPruning");
    const currentScope = {
      sessionId: "scope-session",
      runId: "scope-run",
      observerSessionToken,
    };
    const { handlers, on } = captureHandlers();
    const factory = createModusCompactionExtension(() => currentScope);
    factory({ on } as never);
    const event = { type: "context", messages: duplicateReadMessages() };
    const context = {
      model: { id: "fixture-model", contextWindow: 20_000 },
      signal: undefined,
      getContextUsage: () => ({ tokens: 15_000, contextWindow: 20_000, percent: 75 }),
    };

    const result = await handlers.get("context")?.(event, context);

    expect(result).toMatchObject({
      messages: [
        {
          toolCallId: "read-first",
          content: [{ type: "text", text: expect.stringMatching(/identical later result/i) }],
        },
        { toolCallId: "read-later" },
      ],
    });
    expect(recordPruning).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      "scope-session",
      observerSessionToken,
      "scope-run",
    );

    setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_COMPACTION_PRUNING: false });
    expect(handlers.get("context")?.(event, context)).toBeUndefined();
    expect(recordPruning).toHaveBeenCalledTimes(1);
  });

  it("fails open for cancellation, stale scope, and unavailable context usage", async () => {
    const observer = HarnessObserver.getInstance();
    const observerSessionToken = observer.beginSession("scope-session");
    let current = true;
    const { handlers, on } = captureHandlers();
    const factory = createModusCompactionExtension(() =>
      current
        ? { sessionId: "scope-session", runId: "scope-run", observerSessionToken }
        : undefined,
    );
    factory({ on } as never);
    const event = { type: "context", messages: duplicateReadMessages() };
    const context = {
      model: { id: "fixture-model", contextWindow: 20_000 },
      signal: undefined,
      getContextUsage: () => ({ tokens: 15_000, contextWindow: 20_000, percent: 75 }),
    };
    const originalMessages = event.messages;
    const contextHandler = handlers.get("context");
    if (!contextHandler) throw new Error("Expected the Pi context handler to be registered.");

    const controller = new AbortController();
    controller.abort();
    expect(contextHandler(event, { ...context, signal: controller.signal })).toBeUndefined();

    current = false;
    expect(contextHandler(event, context)).toBeUndefined();
    current = true;
    expect(
      contextHandler(event, {
        ...context,
        getContextUsage: () => {
          throw new Error("unavailable");
        },
      }),
    ).toBeUndefined();
    expect(event.messages).toBe(originalMessages);
  });
});
