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
      abort: vi.fn(async () => {
        if (sessionIndex === 0) mocks.abortHandler?.();
        if (mocks.hangAbortSessionIndexes.includes(sessionIndex)) {
          await new Promise<void>(() => {});
        }
        if (mocks.rejectAbortSessionIndexes.includes(sessionIndex)) {
          throw new Error("isolated abort failure");
        }
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
  vi.useRealTimers();
  mocks.sessions.length = 0;
  mocks.sessionOptions.length = 0;
  mocks.loaderOptions.length = 0;
  mocks.promptTexts.length = 0;
  mocks.rejectAbortSessionIndexes.length = 0;
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

    const result = await runHyperPlanReview(reviewInput());

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
    expect(synthesisInput).not.toContain("Implement the described behavior");
    expect(result.critiques.map((critique) => critique.critic)).toEqual(completionOrder);
    expect(result).toMatchObject({
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

  it("times out a critic, aborts and disposes it, and never treats it as approval", async () => {
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
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await pending;

    expect(result.critiques.find((critique) => critique.critic === "architecture")?.status).toBe(
      "unavailable",
    );
    expect(mocks.sessions[0]?.abort).toHaveBeenCalled();
    expect(mocks.sessions[0]?.dispose).toHaveBeenCalled();
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

  it("caps critic and synthesis inputs and bounds all synthesized fields", async () => {
    useSuccessfulPromptHandler();
    const hugeSpec: PlanSpec = {
      ...spec,
      requirements: Array.from({ length: 100 }, (_, index) => ({
        id: `req-${index}`,
        text: "R".repeat(500),
      })),
    };

    const result = await runHyperPlanReview(
      reviewInput({ planContent: "P".repeat(50_000), spec: hugeSpec }),
    );

    expect(
      mocks.promptTexts.every((prompt) => Buffer.byteLength(prompt, "utf8") <= 24 * 1024),
    ).toBe(true);
    expect(result.agreements.every((text) => text.length <= 500)).toBe(true);
    expect(result.critiques.every((critique) => critique.findings.length <= 12)).toBe(true);
  });

  it("preserves critic results when synthesis fails and discloses no exception text", async () => {
    mocks.promptHandler = async (prompt, emit) => {
      if (prompt.includes("SYNTHESIS_INPUT:")) throw new Error("sensitive synthesis failure");
      const critic = criticId(prompt);
      emit(criticOutput(critic ?? "unknown"));
    };

    const result = await runHyperPlanReview(reviewInput());

    expect(result.critiques).toHaveLength(4);
    expect(result.critiques.every((critique) => critique.status === "completed")).toBe(true);
    expect(result.openQuestions).toContain(
      "HyperPlan synthesis unavailable; no agreement was established.",
    );
    expect(JSON.stringify(result)).not.toContain("sensitive synthesis failure");
  });

  it("treats malformed synthesis as unavailable while preserving the four critic results", async () => {
    mocks.promptHandler = async (prompt, emit) => {
      if (prompt.includes("SYNTHESIS_INPUT:")) {
        emit("malformed synthesis payload");
        return;
      }
      const critic = criticId(prompt);
      emit(criticOutput(critic ?? "unknown"));
    };

    const result = await runHyperPlanReview(reviewInput());

    expect(result.critiques).toHaveLength(4);
    expect(result.critiques.every((critique) => critique.status === "completed")).toBe(true);
    expect(result.agreements).toEqual([]);
    expect(result.openQuestions).toEqual([
      "HyperPlan synthesis unavailable; no agreement was established.",
    ]);
  });

  it("skips synthesis when no critics completed, even if synthesis would claim agreement", async () => {
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

    const result = await runHyperPlanReview(reviewInput());

    expect(mocks.promptTexts).toHaveLength(4);
    expect(mocks.sessions).toHaveLength(4);
    expect(mocks.promptTexts.every((prompt) => criticId(prompt) !== undefined)).toBe(true);
    expect(result.critiques.every((critic) => critic.status === "unavailable")).toBe(true);
    expect(result.agreements).toEqual([]);
    expect(result.disagreements).toEqual([]);
    expect(result.risks).toEqual([]);
    expect(result.references).toEqual([]);
    expect(result.openQuestions.join(" ")).toMatch(/no synthesis.*no approval/i);
    expect(Buffer.byteLength(result.openQuestions[0] ?? "", "utf8")).toBeLessThanOrEqual(500);
  });

  it("synthesizes only completed critics and scopes agreements and disagreements", async () => {
    mocks.promptHandler = async (prompt, emit) => {
      if (prompt.includes("SYNTHESIS_INPUT:")) {
        emit(
          JSON.stringify({
            agreements: ["The design is sound."],
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

  it("caps persisted plan text before critic prompt serialization", async () => {
    useSuccessfulPromptHandler();
    const marker = "UNBOUNDED_PLAN_TAIL_SENTINEL";
    const planContent = `${"P".repeat(40_000)}${marker}`;

    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      await runHyperPlanReview(reviewInput({ planContent }));
      expect(fromSpy.mock.calls.some(([value]) => value === planContent)).toBe(false);
    } finally {
      fromSpy.mockRestore();
    }

    const criticPrompts = mocks.promptTexts.filter((prompt) => criticId(prompt));
    expect(criticPrompts).toHaveLength(4);
    expect(criticPrompts.every((prompt) => Buffer.byteLength(prompt, "utf8") <= 24 * 1024)).toBe(
      true,
    );
    expect(
      criticPrompts.every((prompt) => {
        const serialized = prompt.split("SPEC_AND_PLAN_INPUT:\n")[1];
        return (
          serialized !== undefined &&
          Buffer.byteLength(JSON.parse(serialized).planContent as string, "utf8") <= 12 * 1024
        );
      }),
    ).toBe(true);
    expect(criticPrompts.every((prompt) => !prompt.includes(marker))).toBe(true);
    expect(criticPrompts.every((prompt) => !prompt.includes("P".repeat(40_000)))).toBe(true);
  });

  it("returns only the bounded summary contract", async () => {
    useSuccessfulPromptHandler();

    const result = await runHyperPlanReview(reviewInput());

    expect(Object.keys(result).sort()).toEqual(
      ["critiques", "agreements", "disagreements", "risks", "openQuestions", "references"].sort(),
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
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await pending;
    expect(result.critiques.every((critic) => critic.status === "unavailable")).toBe(true);
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
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await pending;
    expect(result.critiques.find((critic) => critic.critic === "architecture")?.status).toBe(
      "unavailable",
    );
    await expect(runHyperPlanReview(reviewInput())).rejects.toThrow("HyperPlan review busy");
  });
});
