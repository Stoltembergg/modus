import { describe, expect, it } from "vitest";
import { agentPromptSchema } from "../ipc/schemas";
import {
  isModusModelId,
  MODUS_UNAVAILABLE_MESSAGE,
  NO_DEFAULT_MODEL_MESSAGE,
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

  it("no default model configured: the turn is refused (never falls back to the session model)", () => {
    expect(() =>
      userTurnPromptInput(parse({ sessionId: "s1", message: "hi", model: "x/y" }), undefined),
    ).toThrow(NO_DEFAULT_MODEL_MESSAGE);
  });
});

describe("L3b: forced plan default only for Modus; own provider keeps its model", () => {
  const MODUS_PLAN = "modus/deepseek/deepseek-flash";
  function deps(overrides: Partial<TurnModelDeps> = {}): TurnModelDeps {
    const usable = new Set([MODUS_PLAN, "openai/gpt-5", "anthropic/claude-opus-5-5"]);
    return {
      defaultModelId: () => "openai/gpt-5",
      modusTurnModelId: () => MODUS_PLAN,
      isUsable: (id) => usable.has(id),
      ...overrides,
    };
  }

  it("1:1 Modus session: forced to the Modus turn model, whatever it stored", () => {
    expect(resolveTurnModel("modus/anthropic/claude-fable-5-1", deps())).toBe(MODUS_PLAN);
    expect(resolveTurnModel("modus/zai/glm-5.3-flash", deps())).toBe(MODUS_PLAN);
    // With an allowed Modus Settings pick, getModusTurnModelId returns it (model-service).
    expect(
      resolveTurnModel(
        "modus/deepseek/deepseek-flash",
        deps({ modusTurnModelId: () => "modus/anthropic/claude-opus-5-5" }),
      ),
    ).toBe("modus/anthropic/claude-opus-5-5");
  });

  it("1:1 own-provider session keeps its model, even when the Settings default is Modus", () => {
    expect(resolveTurnModel("anthropic/claude-opus-5-5", deps())).toBe("anthropic/claude-opus-5-5");
    expect(
      resolveTurnModel("anthropic/claude-opus-5-5", deps({ defaultModelId: () => MODUS_PLAN })),
    ).toBe("anthropic/claude-opus-5-5");
    // No longer usable (provider disconnected): the Settings default, never stuck.
    expect(resolveTurnModel("gone/model", deps())).toBe("openai/gpt-5");
    expect(resolveTurnModel("gone/model", deps({ defaultModelId: () => MODUS_PLAN }))).toBe(
      MODUS_PLAN,
    );
  });

  it("no stored model: the Settings default, with the Modus rule when it is a Modus model", () => {
    expect(resolveTurnModel(undefined, deps())).toBe("openai/gpt-5");
    expect(
      resolveTurnModel(
        undefined,
        deps({
          defaultModelId: () => "modus/anthropic/claude-fable-5-1",
          modusTurnModelId: () => MODUS_PLAN,
        }),
      ),
    ).toBe(MODUS_PLAN);
    expect(() => resolveTurnModel(undefined, deps({ defaultModelId: () => undefined }))).toThrow(
      NO_DEFAULT_MODEL_MESSAGE,
    );
  });

  it("a Modus session with no usable Modus model is refused (never moved to the user's key)", () => {
    expect(() => resolveTurnModel(MODUS_PLAN, deps({ modusTurnModelId: () => undefined }))).toThrow(
      MODUS_UNAVAILABLE_MESSAGE,
    );
    expect(isModusModelId(MODUS_PLAN)).toBe(true);
    expect(isModusModelId("openai/gpt-5")).toBe(false);
  });

  it("group agent: an explicit own-provider model passes as-is (keepUnusable)", () => {
    expect(resolveTurnModel("openai/gpt-6-luna", deps(), { keepUnusable: true })).toBe(
      "openai/gpt-6-luna",
    );
    expect(resolveTurnModel("modus/zai/glm", deps(), { keepUnusable: true })).toBe(MODUS_PLAN);
  });
});
