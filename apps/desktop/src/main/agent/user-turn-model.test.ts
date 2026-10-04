import { describe, expect, it } from "vitest";
import { agentPromptSchema } from "../ipc/schemas";
import { NO_DEFAULT_MODEL_MESSAGE, userTurnPromptInput } from "./user-turn-model";

const parse = (input: unknown) => agentPromptSchema.parse(input);

describe("L2: every user turn runs on the current Settings default model", () => {
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
