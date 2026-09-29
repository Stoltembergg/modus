import { describe, expect, it, vi } from "vitest";
import {
  AGENT_FALLBACK_INSTRUCTIONS,
  AGENT_FALLBACK_ROLE,
  AGENT_GENERATION_WARNING,
} from "../../shared/agent-templates";
import {
  AGENT_PROFILE_SYSTEM_PROMPT,
  buildAgentProfilePrompt,
  generateAgentProfile,
  type ProfileCompleter,
  parseAgentProfile,
} from "./agent-profile-generator";

const REQUEST = {
  modelId: "openai/gpt-5",
  name: "Cy",
  description: "Keeps the docs honest",
  otherRoles: ["Planner", "Builder", "Builder", " "],
};

const FALLBACK = {
  role: AGENT_FALLBACK_ROLE,
  instructions: AGENT_FALLBACK_INSTRUCTIONS,
  generated: false,
  warning: AGENT_GENERATION_WARNING,
};

function completer(reply: string | (() => Promise<string>)) {
  return vi.fn<ProfileCompleter>(async () => (typeof reply === "string" ? reply : reply()));
}

describe("agent profile generation (mocked provider)", () => {
  it("sends the model, the name, the description and the other roles; returns the profile", async () => {
    const complete = completer('{"role":"Doc keeper","instructions":"You keep the docs current."}');
    await expect(generateAgentProfile(REQUEST, complete)).resolves.toEqual({
      role: "Doc keeper",
      instructions: "You keep the docs current.",
      generated: true,
    });
    const call = complete.mock.calls[0]?.[0];
    expect(call?.modelId).toBe("openai/gpt-5");
    expect(call?.systemPrompt).toBe(AGENT_PROFILE_SYSTEM_PROMPT);
    expect(call?.prompt).toBe(
      [
        "Agent name: Cy",
        "What it should help with: Keeps the docs honest",
        "Roles already in the group: Planner, Builder",
      ].join("\n"),
    );
    expect(AGENT_PROFILE_SYSTEM_PROMPT).toContain("complements the existing members' roles");
  });

  it("the prompt without a description or other members", () => {
    expect(buildAgentProfilePrompt({ modelId: "m", name: " Solo ", otherRoles: [] })).toBe(
      [
        "Agent name: Solo",
        "What it should help with: (not given)",
        "Roles already in the group: (none yet)",
      ].join("\n"),
    );
  });

  it("accepts fenced JSON or text around it, and cuts role (40) and instructions (1500)", () => {
    expect(
      parseAgentProfile('Sure!\n```json\n{"role":"QA","instructions":"You test."}\n```'),
    ).toEqual({ role: "QA", instructions: "You test." });
    const long = parseAgentProfile(
      JSON.stringify({ role: "R".repeat(60), instructions: "I".repeat(2000) }),
    );
    expect(long?.role).toHaveLength(40);
    expect(long?.instructions).toHaveLength(1500);
  });

  it.each([
    ["invalid JSON", "role: QA"],
    ["missing instructions", '{"role":"QA"}'],
    ["empty role", '{"role":"  ","instructions":"x"}'],
    ["not an object", '["QA","x"]'],
  ])("falls back to Generalist with a warning on %s", async (_label, reply) => {
    await expect(generateAgentProfile(REQUEST, completer(reply))).resolves.toEqual(FALLBACK);
  });

  it("falls back when the provider fails", async () => {
    const complete = completer(async () => {
      throw new Error("401 unauthorized");
    });
    await expect(generateAgentProfile(REQUEST, complete)).resolves.toEqual(FALLBACK);
  });

  it("falls back on timeout and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    const complete = vi.fn<ProfileCompleter>(
      (request) =>
        new Promise<string>(() => {
          signal = request.signal;
        }),
    );
    await expect(generateAgentProfile(REQUEST, complete, { timeoutMs: 5 })).resolves.toEqual(
      FALLBACK,
    );
    expect(signal?.aborted).toBe(true);
  });

  it("each call is a new generation (Regenerate asks again)", async () => {
    const replies = [
      '{"role":"First","instructions":"One."}',
      '{"role":"Second","instructions":"Two."}',
    ];
    const complete = vi.fn<ProfileCompleter>(async () => replies.shift() ?? "");
    expect((await generateAgentProfile(REQUEST, complete)).role).toBe("First");
    expect((await generateAgentProfile(REQUEST, complete)).role).toBe("Second");
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
