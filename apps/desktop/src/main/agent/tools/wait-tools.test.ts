import { describe, expect, it } from "vitest";
import { toolRegistry } from "./registry";
import { runWithAgentToolContext } from "./tool-context";
import { formatWaitedDuration, formatWaitHeadline, registerWaitTools } from "./wait-tools";

describe("formatWaitHeadline", () => {
  it("names a single subagent and duration from result facts", () => {
    expect(
      formatWaitHeadline({
        waitedMs: 12_000,
        timedOut: false,
        subagents: [{}],
      }),
    ).toBe("Waited 12s for subagent");
  });

  it("pluralizes subagents from the authoritative count", () => {
    expect(
      formatWaitHeadline({
        waitedMs: 65_000,
        timedOut: false,
        subagents: [{}, {}],
      }),
    ).toBe("Waited 1m 5s for 2 subagents");
  });

  it("marks timeout without losing the subject", () => {
    expect(
      formatWaitHeadline({
        waitedMs: 120_000,
        timedOut: true,
        subagents: [{}, {}, {}],
      }),
    ).toBe("Waited 2m for 3 subagents (timed out)");
  });

  it("omits subject when nothing was watched", () => {
    expect(
      formatWaitHeadline({
        waitedMs: 0,
        timedOut: false,
        subagents: [],
      }),
    ).toBe(`Waited ${formatWaitedDuration(0)}`);
  });
});

describe("wait memory candidate summaries", () => {
  it("prints cited ids, categories, and claims without exposing transcript fields", async () => {
    registerWaitTools({
      waitBackground: async () =>
        ({
          waitedMs: 10,
          timedOut: false,
          subagents: [
            {
              id: "child-session",
              task: "Inspect cache",
              status: "completed",
              memoryCandidates: [
                {
                  id: "memory-123",
                  category: "decision",
                  claim: "Normalize keys before caching.",
                  transcript: "private raw transcript must not be shown",
                },
              ],
            },
          ],
        }) as never,
    });
    const wait = toolRegistry.getCustomToolDefinitions("chat").find((tool) => tool.name === "wait");
    if (!wait?.execute) throw new Error("wait tool missing");
    const result = await runWithAgentToolContext(
      {
        workspaceId: "ws",
        cwd: "/repo",
        sessionId: "parent-session",
      },
      () => wait.execute?.("wait-call", {}, undefined, undefined, { cwd: "/repo" } as never),
    );
    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("memory-123");
    expect(text).toContain("decision");
    expect(text).toContain("Normalize keys before caching.");
    expect(text).not.toContain("private raw transcript");
  });

  it("prints CodeGraph discoveries separately from output excerpts and marks worktree refs provisional", async () => {
    registerWaitTools({
      waitBackground: async () =>
        ({
          waitedMs: 5,
          timedOut: false,
          subagents: [
            {
              id: "child-session",
              task: "Find implementation",
              status: "completed",
              output: "Ordinary child output excerpt.",
              discoveries: [
                {
                  runId: "child-run",
                  path: "src/agent.ts",
                  symbol: "Agent.run",
                  line: 19,
                  kind: "function",
                  provisional: true,
                },
              ],
            },
          ],
        }) as never,
    });
    const wait = toolRegistry.getCustomToolDefinitions("chat").find((tool) => tool.name === "wait");
    if (!wait?.execute) throw new Error("wait tool missing");

    const result = await runWithAgentToolContext(
      { workspaceId: "ws", cwd: "/repo", sessionId: "parent-session" },
      () => wait.execute?.("wait-codegraph", {}, undefined, undefined, { cwd: "/repo" } as never),
    );
    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
    const details = result?.details as {
      subagents: Array<{ discoveries?: Array<Record<string, unknown>>; output?: string }>;
    };
    const discoveries = details.subagents[0]?.discoveries ?? [];

    expect(text).toContain("CodeGraph discoveries:");
    expect(text).toContain("src/agent.ts:19");
    expect(text).toContain("Agent.run");
    expect(text).toContain("provisional");
    expect(text).toContain("Ordinary child output excerpt.");
    expect(discoveries).toEqual([
      expect.objectContaining({
        runId: "child-run",
        path: "src/agent.ts",
        symbol: "Agent.run",
        line: 19,
        kind: "function",
        provisional: true,
      }),
    ]);
    expect(JSON.stringify(discoveries)).not.toContain("query");
    expect(JSON.stringify(discoveries)).not.toContain("Ordinary child output excerpt");
  });
});
