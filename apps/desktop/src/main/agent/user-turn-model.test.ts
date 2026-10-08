import { describe, expect, it, vi } from "vitest";
import { agentPromptSchema } from "../ipc/schemas";
import {
  NO_DEFAULT_MODEL_MESSAGE,
  resolveExplicitTurnModel,
  resolveTurnModel,
  type TurnModelDeps,
  userTurnPromptInput,
} from "./user-turn-model";

const parse = (input: unknown) => agentPromptSchema.parse(input);

describe("userTurnPromptInput (L2 fields; model from resolveTurnModel, L3b)", () => {
  it("ignores the model and thinking the renderer sends (an old session's stored model)", () => {
    const input = userTurnPromptInput(
      parse({
        sessionId: "s1",
        message: "hi",
        model: "openai/old-session-model",
        thinkingLevel: "xhigh",
        thinkingVariant: "max",
        mode: "plan",
      }),
      "anthropic/claude-opus-5-5",
    );
    expect(input).toEqual({
      sessionId: "s1",
      message: "hi",
      context: [],
      mode: "plan",
      model: "anthropic/claude-opus-5-5",
    });
    expect(input).not.toHaveProperty("thinkingLevel");
    expect(input).not.toHaveProperty("thinkingVariant");
  });

  it("applies the default even when the renderer sends no model", () => {
    expect(userTurnPromptInput(parse({ sessionId: "s1", message: "hi" }), "zai/glm").model).toBe(
      "zai/glm",
    );
  });

  it("follows a Settings default change on the very next turn", () => {
    const payload = parse({ sessionId: "s1", message: "hi", model: "a/one" });
    expect(userTurnPromptInput(payload, "a/one").model).toBe("a/one");
    expect(userTurnPromptInput(payload, "b/two").model).toBe("b/two");
  });

  it("keeps the other per-turn fields", () => {
    const input = userTurnPromptInput(
      parse({
        sessionId: "s1",
        message: "hi",
        delivery: "steer",
        userMessageId: "u1",
        planId: "p1",
        skills: [],
      }),
      "m/default",
    );
    expect(input).toMatchObject({
      delivery: "steer",
      userMessageId: "u1",
      planId: "p1",
      skills: [],
    });
  });

  it("leaves an absent stored selection for runtime session restoration", () => {
    const input = userTurnPromptInput(
      parse({ sessionId: "s1", message: "hi", model: "renderer/untrusted" }),
      undefined,
    );

    expect(input).not.toHaveProperty("model");
  });

  it("preserves an explicit request to use the current Settings default", () => {
    const input = userTurnPromptInput(
      parse({ sessionId: "s1", message: "hi", model: "renderer/untrusted" }),
      null,
    );

    expect(input).toHaveProperty("model", null);
  });
});

describe("explicit turn model identity", () => {
  const MODUS_PLAN = "modus/deepseek/deepseek-flash";
  function deps(overrides: Partial<TurnModelDeps> = {}): TurnModelDeps {
    const usable = new Set([
      MODUS_PLAN,
      "modus/anthropic/claude-opus-5-5",
      "openai/gpt-5",
      "anthropic/claude-opus-5-5",
    ]);
    return {
      defaultModelId: () => "openai/gpt-5",
      isUsable: (id) => usable.has(id),
      ...overrides,
    };
  }

  it("preserves the exact selected Modus model instead of remapping to the plan model", () => {
    const selected = "modus/anthropic/claude-opus-5-5";
    expect(
      resolveTurnModel(
        selected,
        deps({
          isUsable: (id) => id === selected,
        }),
      ),
    ).toBe(selected);
  });

  it("preserves the selected BYOK model when the Settings default is another provider", () => {
    expect(resolveTurnModel("anthropic/claude-opus-5-5", deps())).toBe("anthropic/claude-opus-5-5");
    expect(
      resolveTurnModel("anthropic/claude-opus-5-5", deps({ defaultModelId: () => MODUS_PLAN })),
    ).toBe("anthropic/claude-opus-5-5");
  });

  it("uses the Settings default only when the session has no stored model", () => {
    expect(resolveTurnModel(undefined, deps())).toBe("openai/gpt-5");
    expect(resolveTurnModel(undefined, deps({ defaultModelId: () => MODUS_PLAN }))).toBe(
      MODUS_PLAN,
    );
    expect(() => resolveTurnModel(undefined, deps({ defaultModelId: () => undefined }))).toThrow(
      NO_DEFAULT_MODEL_MESSAGE,
    );
  });

  it("leaves an absent persisted choice unresolved until the runtime restores the session", () => {
    const defaultModelId = vi.fn(() => "openai/gpt-5");

    expect(resolveExplicitTurnModel(undefined, deps({ defaultModelId }))).toBeUndefined();
    expect(defaultModelId).not.toHaveBeenCalled();
  });

  it("rejects an unavailable persisted choice without substituting the default", () => {
    const selected = "byok/removed-model";
    const defaultModelId = vi.fn(() => "openai/gpt-5");

    expect(() =>
      resolveExplicitTurnModel(
        selected,
        deps({ defaultModelId, isUsable: () => false }),
      ),
    ).toThrow(`Selected model is unavailable: ${selected}`);
    expect(defaultModelId).not.toHaveBeenCalled();
  });

  it.each([
    "openai/removed-model",
    "modus/removed-model",
  ])("refuses an unavailable explicit model %s without consulting the Settings default", (selected) => {
    const defaultModelId = vi.fn(() => "openai/gpt-5");
    expect(() =>
      resolveTurnModel(selected, deps({ defaultModelId, isUsable: () => false })),
    ).toThrow(`Selected model is unavailable: ${selected}`);
    expect(defaultModelId).not.toHaveBeenCalled();
  });

  it("refuses a stale explicit Settings default", () => {
    expect(() =>
      resolveTurnModel(
        undefined,
        deps({ defaultModelId: () => "byok/removed-model", isUsable: () => false }),
      ),
    ).toThrow("Selected model is unavailable: byok/removed-model");
  });

  it("preserves the Modus identity and identifies it in errors", () => {
    expect(() => resolveTurnModel(MODUS_PLAN, deps({ isUsable: () => false }))).toThrow(
      `Selected model is unavailable: ${MODUS_PLAN}`,
    );
  });

  it("group agent selection uses the exact model and refuses a removed member model", () => {
    expect(resolveTurnModel("openai/gpt-5", deps())).toBe("openai/gpt-5");
    expect(() =>
      resolveTurnModel("openai/removed-group-model", deps({ isUsable: () => false })),
    ).toThrow("Selected model is unavailable: openai/removed-group-model");
  });
});
