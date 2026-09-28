import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanSpec } from "../../../shared/contracts";

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{
    prompt: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  sessionOptions: [] as Array<Record<string, unknown>>,
  loaderOptions: [] as Array<Record<string, unknown>>,
  promptTexts: [] as string[],
  rejectAbortSessionIndexes: [] as number[],
  throwAbortSessionIndexes: [] as number[],
  hangAbortSessionIndexes: [] as number[],
  abortHandler: undefined as (() => void) | undefined,
  createSessionHandler: undefined as
    | ((options: Record<string, unknown>) => Promise<{ session: unknown }>)
    | undefined,
  defaultLoaderCalls: 0,
  extensionRuntime: { kind: "empty-extension-runtime" },
  inMemory: vi.fn(() => ({ kind: "in-memory-session" })),
  settingsInMemory: vi.fn(() => ({ kind: "in-memory-settings" })),
  promptHandler: undefined as
    | ((prompt: string, emit: (text: string) => void) => Promise<void>)
    | undefined,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
    mocks.sessionOptions.push(options);
    if (mocks.createSessionHandler) return mocks.createSessionHandler(options);
    const sessionIndex = mocks.sessions.length;
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      }),
      prompt: vi.fn(async (prompt: string) => {
        mocks.promptTexts.push(prompt);
        await mocks.promptHandler?.(prompt, (text) => {
          for (const listener of listeners) {
            listener({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: text },
            });
          }
        });
      }),
      abort: vi.fn(() => {
        if (sessionIndex === 0) mocks.abortHandler?.();
        if (mocks.throwAbortSessionIndexes.includes(sessionIndex)) {
          throw new Error("synchronous isolated abort failure");
        }
        if (mocks.hangAbortSessionIndexes.includes(sessionIndex)) {
          return new Promise<void>(() => {});
        }
        if (mocks.rejectAbortSessionIndexes.includes(sessionIndex)) {
          return Promise.reject(new Error("isolated abort failure"));
        }
        return Promise.resolve();
      }),
      dispose: vi.fn(),
    };
    mocks.sessions.push(session);
    return { session };
  }),
  DefaultResourceLoader: class {
    constructor(options: Record<string, unknown>) {
      mocks.defaultLoaderCalls += 1;
      mocks.loaderOptions.push(options);
    }
    async reload(): Promise<void> {}
  },
  createExtensionRuntime: vi.fn(() => mocks.extensionRuntime),
  SessionManager: { inMemory: mocks.inMemory },
  SettingsManager: { inMemory: mocks.settingsInMemory },
}));

vi.mock("../model-service", () => ({
  getDefaultModel: () => ({ id: "test-model" }),
  getModelRegistry: () => ({ authStorage: {}, modelRegistry: {} }),
}));

import { runHyperPlanReview } from "./hyperplan";

const spec: PlanSpec = {
  requirements: [{ id: "req-one", text: "The requirement." }],
  acceptanceCriteria: [
    {
      id: "ac-one",
      requirementId: "req-one",
      description: "The observable behavior.",
      todoIds: ["todo-one"],
      requiredCheckKinds: ["tests"],
      status: "pending",
    },
  ],
  evidence: [],
  assumptions: ["A documented assumption."],
  openQuestions: ["An unresolved question."],
};

const criticOutput = (critic: string) =>
  JSON.stringify({ findings: [`Finding from ${critic}`], references: [`${critic}.md#section`] });
const synthesisOutput = JSON.stringify({
  revisedContent: "# Feature\nUse the reviewed approach.",
  agreements: ["The reviewers agree."],
  disagreements: [],
  risks: ["A bounded risk."],
  openQuestions: ["A question remains."],
  references: ["plan.md#acceptance"],
});

function criticId(prompt: string): string | undefined {
  return /CRITIC_ID: (architecture|risk|simplicity|failure)/.exec(prompt)?.[1];
}

function useSuccessfulPromptHandler(): void {
  mocks.promptHandler = async (prompt, emit) => {
    emit(
      prompt.includes("SYNTHESIS_INPUT:")
        ? synthesisOutput
        : criticOutput(criticId(prompt) ?? "unknown"),
    );
  };
}

const reviewInput = (overrides: Record<string, unknown> = {}) => ({
  planContent: "# Feature\nImplement the described behavior.",
  spec,
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  mocks.sessions.length = 0;
  mocks.sessionOptions.length = 0;
  mocks.loaderOptions.length = 0;
  mocks.promptTexts.length = 0;
  mocks.rejectAbortSessionIndexes.length = 0;
  mocks.throwAbortSessionIndexes.length = 0;
  mocks.hangAbortSessionIndexes.length = 0;
  mocks.abortHandler = undefined;
  mocks.createSessionHandler = undefined;
  mocks.defaultLoaderCalls = 0;
  mocks.inMemory.mockClear();
  mocks.settingsInMemory.mockClear();
  mocks.promptHandler = undefined;
});

describe("runHyperPlanReview", () => {
  it("runs four fixed independent critics concurrently, then one synthesis pass", async () => {
    // Fake timers: every critic schedules its delay against the same frozen clock, so the
    // finish order below is fixed. With real timers, a >2ms scheduling gap between critic
    // starts (loaded CI runner) let "architecture" finish before "failure".
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const completionOrder: string[] = [];
    mocks.promptHandler = async (prompt, emit) => {
      const critic = criticId(prompt);
      if (critic) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, { risk: 0, simplicity: 2, failure: 4, architecture: 6 }[critic]),
        );
        completionOrder.push(critic);
        active -= 1;
        emit(criticOutput(critic));
      } else {
        emit(synthesisOutput);
      }
    };

    const pending = runHyperPlanReview(reviewInput());
    await vi.advanceTimersByTimeAsync(6);
    const result = await pending;

    expect(maxActive).toBe(4);
    expect(mocks.promptTexts.filter((prompt) => criticId(prompt)).map(criticId)).toEqual([
      "architecture",
      "risk",
      "simplicity",
      "failure",
    ]);
    expect(completionOrder).toEqual(["risk", "simplicity", "failure", "architecture"]);
    expect(mocks.promptTexts).toHaveLength(5);
    const synthesisInput = mocks.promptTexts.find((prompt) => prompt.includes("SYNTHESIS_INPUT:"));
    expect(synthesisInput).toContain("Finding from architecture");
    expect(synthesisInput).toContain("Implement the described behavior");
    expect(synthesisInput).toContain('"requirements":[{"id":"req-one"');
    expect(result.critiques.map((critique) => critique.critic)).toEqual(completionOrder);
    expect(result).toMatchObject({
      revisedContent: "# Feature\nUse the reviewed approach.",
      agreements: ["Among completed critics: The reviewers agree."],
      risks: ["A bounded risk."],
    });
  });

  it("uses an empty tool allowlist and isolated in-memory sessions without workspace extensions", async () => {
    useSuccessfulPromptHandler();

    await runHyperPlanReview(reviewInput());

    expect(mocks.sessionOptions).toHaveLength(5);
    expect(
      mocks.sessionOptions.every(
        (options) => (options.tools as unknown[] | undefined)?.length === 0,
      ),
    ).toBe(true);
    expect(
      mocks.sessionOptions.every(
        (options) => (options.customTools as unknown[] | undefined)?.length === 0,
      ),
    ).toBe(true);
    expect(mocks.sessionOptions.every((options) => options.noTools === "all")).toBe(true);
    expect(mocks.inMemory).toHaveBeenCalledTimes(5);
    expect(mocks.defaultLoaderCalls).toBe(0);
    expect(
      mocks.sessionOptions.every((options) => {
        const loader = options.resourceLoader as Record<string, unknown>;
        return (
          loader &&
          typeof loader.reload === "function" &&
          typeof loader.extendResources === "function" &&
          typeof loader.getExtensions === "function" &&
          typeof loader.getSystemPrompt === "function" &&
          loader.getSystemPrompt() === ""
        );
      }),
    ).toBe(true);
    expect(
      mocks.sessionOptions.every((options) => {
        const loader = options.resourceLoader as { getExtensions: () => { extensions: unknown[] } };
        return loader.getExtensions().extensions.length === 0;
      }),
    ).toBe(true);
    expect(
      mocks.sessionOptions.every((options) => {
        const loader = options.resourceLoader as { getExtensions: () => { runtime: unknown } };
        return loader.getExtensions().runtime === mocks.extensionRuntime;
      }),
    ).toBe(true);
  });

  it.each([
    ["malformed JSON", "not json"],
    ["too many findings", JSON.stringify({ findings: Array(13).fill("finding"), references: [] })],
    ["oversized output", JSON.stringify({ findings: ["x".repeat(7000)], references: [] })],
  ])("maps %s critic output to unavailable without leaking its text", async (_name, malformed) => {
    mocks.promptHandler = async (prompt, emit) => {
      const critic = criticId(prompt);
      emit(critic === "risk" ? malformed : critic ? criticOutput(critic) : synthesisOutput);
    };

    const result = await runHyperPlanReview(reviewInput());

    expect(result.critiques.find((critique) => critique.critic === "risk")).toEqual({
      critic: "risk",
      status: "unavailable",
      findings: [],
      references: [],
    });
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
    expect(JSON.stringify(result)).not.toContain("not json");
  });

  it("rejects a timed-out critic without starting synthesis", async () => {
    vi.useFakeTimers();
    let finishPrompt: (() => void) | undefined;
    mocks.promptHandler = async (prompt, emit) => {
      if (criticId(prompt) === "architecture") {
        await new Promise<void>((resolve) => {
          finishPrompt = resolve;
        });
      }
      const critic = criticId(prompt);
      emit(critic ? criticOutput(critic) : synthesisOutput);
    };
    mocks.abortHandler = () => finishPrompt?.();
    const pending = runHyperPlanReview(reviewInput());
    const rejected = expect(pending).rejects.toMatchObject({
      reason: "critic_timeout",
      message: expect.stringMatching(/timed out/i),
    });
    await vi.advanceTimersByTimeAsync(60_001);
    await rejected;

    expect(mocks.sessions[0]?.abort).toHaveBeenCalled();
    expect(mocks.sessions[0]?.dispose).toHaveBeenCalled();
    expect(mocks.promptTexts.some((prompt) => prompt.includes("SYNTHESIS_INPUT:"))).toBe(false);
  });

  it("maps a critic exception or failed cleanup to unavailable without rejecting the review", async () => {
    mocks.promptHandler = async (prompt, emit) => {
      const critic = criticId(prompt);
      if (critic === "risk") throw new Error("private critic failure");
      emit(critic ? criticOutput(critic) : synthesisOutput);
    };
    const result = await runHyperPlanReview(reviewInput());

    expect(result.critiques.find((critique) => critique.critic === "risk")).toEqual({
      critic: "risk",
      status: "unavailable",
      findings: [],
      references: [],
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("rejects total critic failure with the original cause and can retry", async () => {
    mocks.promptHandler = async (prompt) => {
      if (criticId(prompt)) throw new Error("429: temporary rate limit");
    };

    await expect(runHyperPlanReview(reviewInput())).rejects.toThrow("429: temporary rate limit");
    expect(mocks.promptTexts).toHaveLength(4);

    useSuccessfulPromptHandler();
    await expect(runHyperPlanReview(reviewInput())).resolves.toMatchObject({
      revisedContent: expect.any(String),
    });
  });

  it("keeps the accepted full plan body in critic and synthesis prompts", async () => {
    useSuccessfulPromptHandler();
    const marker = "FINAL_PLAN_BODY_SENTINEL";
    const planContent = `${"P".repeat(10_000)}${marker}`;

    const result = await runHyperPlanReview(reviewInput({ planContent }));

    expect(
      mocks.promptTexts.every((prompt) => Buffer.byteLength(prompt, "utf8") <= 24 * 1024),
    ).toBe(true);
    expect(
      mocks.promptTexts
        .filter((prompt) => criticId(prompt))
        .every((prompt) => {
          const serialized = prompt.split("SPEC_AND_PLAN_INPUT:\n")[1];
          return serialized !== undefined && JSON.parse(serialized).planContent === planContent;
        }),
    ).toBe(true);
    const synthesis = mocks.promptTexts.find((prompt) => prompt.includes("SYNTHESIS_INPUT:"));
    const synthesisInput = synthesis?.slice((synthesis.lastIndexOf("\n") ?? -1) + 1);
    expect(synthesisInput).toBeDefined();
    expect(JSON.parse(synthesisInput ?? "{}").planContent).toBe(planContent);
    expect(result.agreements.every((text) => text.length <= 500)).toBe(true);
    expect(result.critiques.every((critique) => critique.findings.length <= 12)).toBe(true);
  });

  it("rejects a plan over 12 KiB before starting any critic prompt", async () => {
    useSuccessfulPromptHandler();

    await expect(
      runHyperPlanReview(reviewInput({ planContent: "x".repeat(12 * 1024 + 1) })),
    ).rejects.toThrow(/12 KiB/i);
    expect(mocks.promptTexts).toHaveLength(0);
  });

  it("rejects with the synthesis failure cause when synthesis fails", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.promptHandler = async (prompt, emit) => {
      if (prompt.includes("SYNTHESIS_INPUT:")) throw new Error("sensitive synthesis failure");
      const critic = criticId(prompt);
      emit(criticOutput(critic ?? "unknown"));
    };

    await expect(runHyperPlanReview(reviewInput())).rejects.toThrow("sensitive synthesis failure");
    expect(log).toHaveBeenCalledWith("[HyperPlan] stage=synthesis reason=prompt_failure");
  });

  it("rejects malformed synthesis instead of returning a summary without a revision", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.promptHandler = async (prompt, emit) => {
      if (prompt.includes("SYNTHESIS_INPUT:")) {
        emit("malformed synthesis payload");
        return;
      }
      const critic = criticId(prompt);
      emit(criticOutput(critic ?? "unknown"));
    };

    await expect(runHyperPlanReview(reviewInput())).rejects.toThrow(/synthesis|JSON/i);
    expect(log).toHaveBeenCalledWith("[HyperPlan] stage=synthesis reason=invalid_synthesis_output");
  });

  it("skips synthesis when no critics completed and rejects with a critic cause", async () => {
    mocks.promptHandler = async (prompt, emit) => {
      if (prompt.includes("SYNTHESIS_INPUT:")) {
        emit(synthesisOutput);
        return;
      }
      if (criticId(prompt) === "architecture" || criticId(prompt) === "risk") {
        throw new Error("private critic request failure");
      }
      emit("malformed critic output");
    };

    await expect(runHyperPlanReview(reviewInput())).rejects.toThrow(
      "private critic request failure",
    );

    expect(mocks.promptTexts).toHaveLength(4);
    expect(mocks.sessions).toHaveLength(4);
    expect(mocks.promptTexts.every((prompt) => criticId(prompt) !== undefined)).toBe(true);
  });

  it("synthesizes only completed critics and scopes agreements and disagreements", async () => {
    mocks.promptHandler = async (prompt, emit) => {
      if (prompt.includes("SYNTHESIS_INPUT:")) {
        emit(
          JSON.stringify({
            agreements: ["The design is sound."],
            revisedContent: "# Feature\nUse the reviewed approach.",
            disagreements: ["The timeline differs."],
            risks: [],
            openQuestions: [],
            references: [],
          }),
        );
        return;
      }
      const id = criticId(prompt);
      emit(id === "architecture" || id === "risk" ? criticOutput(id) : "malformed critic output");
    };

    const result = await runHyperPlanReview(reviewInput());
    const synthesisInput = mocks.promptTexts.find((prompt) => prompt.includes("SYNTHESIS_INPUT:"));

    expect(synthesisInput).toContain("architecture");
    expect(synthesisInput).toContain('"critic":"risk"');
    expect(synthesisInput).not.toContain('"critic":"simplicity"');
    expect(synthesisInput).not.toContain('"critic":"failure"');
    expect(result.agreements).toEqual(["Among completed critics: The design is sound."]);
    expect(result.disagreements).toEqual(["Among completed critics: The timeline differs."]);
  });

  it("does not claim peer agreement from exactly one completed critic", async () => {
    mocks.promptHandler = async (prompt, emit) => {
      if (prompt.includes("SYNTHESIS_INPUT:")) {
        emit(
          JSON.stringify({
            agreements: ["The design is sound."],
            revisedContent: "# Feature\nUse the reviewed approach.",
            disagreements: ["The timeline differs."],
            risks: ["The migration needs a rollback."],
            openQuestions: ["Which deployment window is available?"],
            references: ["plan.md#deployment"],
          }),
        );
        return;
      }
      const id = criticId(prompt);
      emit(id === "architecture" ? criticOutput(id) : "malformed critic output");
    };

    const result = await runHyperPlanReview(reviewInput());

    expect(result.critiques.filter((critic) => critic.status === "completed")).toHaveLength(1);
    expect(result.agreements).toEqual([]);
    expect(result.disagreements).toEqual([]);
    expect(result.risks).toEqual(["The migration needs a rollback."]);
    expect(result.openQuestions).toEqual(["Which deployment window is available?"]);
    expect(result.references).toEqual(["plan.md#deployment"]);
  });

  it("returns only the bounded summary contract", async () => {
    useSuccessfulPromptHandler();

    const result = await runHyperPlanReview(reviewInput());

    expect(Object.keys(result).sort()).toEqual(
      [
        "critiques",
        "agreements",
        "disagreements",
        "risks",
        "openQuestions",
        "references",
        "revisedContent",
      ].sort(),
    );
    expect(
      result.critiques.every(
        (item) => Object.keys(item).sort().join(",") === "critic,findings,references,status",
      ),
    ).toBe(true);
  });

  it("rejects an overlapping process-global review without creating extra sessions", async () => {
    let finishFirstPrompt: (() => void) | undefined;
    mocks.promptHandler = async (prompt, emit) => {
      if (criticId(prompt) === "architecture") {
        await new Promise<void>((resolve) => {
          finishFirstPrompt = resolve;
        });
      }
      const critic = criticId(prompt);
      emit(critic ? criticOutput(critic) : synthesisOutput);
    };

    const first = runHyperPlanReview(reviewInput());
    await vi.waitFor(() => expect(mocks.promptTexts.length).toBeGreaterThan(0));
    await expect(runHyperPlanReview(reviewInput())).rejects.toThrow("HyperPlan review busy");
    finishFirstPrompt?.();
    await first;
    expect(mocks.sessionOptions).toHaveLength(5);
  });

  it("bounds hanging session creation and cleans a late session while retaining admission", async () => {
    vi.useFakeTimers();
    const finishCreations: Array<(value: { session: unknown }) => void> = [];
    const lateSession = {
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    mocks.createSessionHandler = async () =>
      new Promise((resolve) => {
        finishCreations.push(resolve);
      });

    const pending = runHyperPlanReview(reviewInput());
    const timedOut = expect(pending).rejects.toThrow(/timed out/i);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_001);
    await timedOut;
    expect(mocks.promptTexts).toHaveLength(0);

    await expect(runHyperPlanReview(reviewInput())).rejects.toThrow("HyperPlan review busy");
    for (const finish of finishCreations) finish({ session: lateSession });
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(lateSession.dispose).toHaveBeenCalledTimes(4);
    expect(lateSession.abort).toHaveBeenCalled();
    expect(mocks.sessionOptions.every((options) => !existsSync(options.cwd as string))).toBe(true);
    mocks.createSessionHandler = undefined;
    useSuccessfulPromptHandler();
    await runHyperPlanReview(reviewInput());
  });

  it("quarantines review admission when abort never settles", async () => {
    vi.useFakeTimers();
    mocks.hangAbortSessionIndexes = [0];
    mocks.promptHandler = async (prompt, emit) => {
      const critic = criticId(prompt);
      if (critic === "architecture") return await new Promise<void>(() => {});
      emit(critic ? criticOutput(critic) : synthesisOutput);
    };
    const pending = runHyperPlanReview(reviewInput());
    const timedOut = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.advanceTimersByTimeAsync(5_001);
    await timedOut;
    await expect(runHyperPlanReview(reviewInput())).rejects.toThrow("HyperPlan review busy");
  });

  it("quarantines and rejects when abort throws synchronously for a pending critic", async () => {
    vi.useFakeTimers();
    let finishPrompt: (() => void) | undefined;
    mocks.throwAbortSessionIndexes = [0];
    mocks.promptHandler = async (prompt, emit) => {
      const critic = criticId(prompt);
      if (critic === "architecture") {
        await new Promise<void>((resolve) => {
          finishPrompt = resolve;
        });
      }
      emit(critic ? criticOutput(critic) : synthesisOutput);
    };

    vi.resetModules();
    const isolatedHarness = await import("./hyperplan");
    const pending = isolatedHarness.runHyperPlanReview(reviewInput());
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(60_001);
    const outcome = await settled;
    finishPrompt?.();
    for (let index = 0; index < 12; index += 1) await Promise.resolve();

    expect(outcome).toHaveProperty("error");
    expect((outcome as { error?: { reason?: string } }).error?.reason).toBe("critic_quarantine");
    expect(String((outcome as { error?: unknown }).error)).toMatch(
      /synchronous isolated abort failure/i,
    );
    expect(mocks.promptTexts.some((prompt) => prompt.includes("SYNTHESIS_INPUT:"))).toBe(false);
    await expect(isolatedHarness.runHyperPlanReview(reviewInput())).rejects.toThrow(
      "HyperPlan review busy",
    );
  });
});
