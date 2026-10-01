import { describe, expect, it } from "vitest";
import {
  deriveGroupCollabStage,
  findGroupCollabStatuses,
  formatGroupCollabStatus,
  lastGroupCollabStatus,
  needsNextOwnerNudge,
  parseGroupCollabStatusLine,
  stageFromCollabStatus,
} from "./group-collab-status";

describe("parseGroupCollabStatusLine", () => {
  it("parses handoff, blocked, proposed, agreed, ready", () => {
    expect(parseGroupCollabStatusLine("Handoff → @Builder · toggle + tests")).toEqual({
      kind: "handoff",
      targetName: "Builder",
      objective: "toggle + tests",
    });
    expect(parseGroupCollabStatusLine("Blocked · missing API key")).toEqual({
      kind: "blocked",
      reason: "missing API key",
    });
    expect(parseGroupCollabStatusLine("Proposed · dark mode ready")).toEqual({
      kind: "proposed",
      summary: "dark mode ready",
    });
    expect(parseGroupCollabStatusLine("Agreed")).toEqual({ kind: "agreed", note: "" });
    expect(parseGroupCollabStatusLine("Agreed · open PR when ready")).toEqual({
      kind: "agreed",
      note: "open PR when ready",
    });
    expect(parseGroupCollabStatusLine("Ready for you")).toEqual({ kind: "ready" });
  });

  it("ignores ordinary lines", () => {
    expect(parseGroupCollabStatusLine("I'll hand this to Builder")).toBeUndefined();
    expect(parseGroupCollabStatusLine("Waiting for you")).toBeUndefined();
  });

  it("parses supported member names with spaces, with and without an objective", () => {
    expect(parseGroupCollabStatusLine("Handoff → @Jennie 2 · revisar os testes")).toEqual({
      kind: "handoff",
      targetName: "Jennie 2",
      objective: "revisar os testes",
    });
    expect(parseGroupCollabStatusLine("Handoff → @Jennie 2")).toEqual({
      kind: "handoff",
      targetName: "Jennie 2",
      objective: "",
    });
    expect(parseGroupCollabStatusLine("Handoff → @ · work")).toBeUndefined();
  });
});

describe("formatGroupCollabStatus", () => {
  it("round-trips the canonical prefixes", () => {
    const samples = [
      { kind: "handoff" as const, targetName: "Builder", objective: "toggle + tests" },
      { kind: "blocked" as const, reason: "missing key" },
      { kind: "proposed" as const, summary: "done" },
      { kind: "agreed" as const, note: "" },
      { kind: "ready" as const },
    ];
    for (const sample of samples) {
      expect(parseGroupCollabStatusLine(formatGroupCollabStatus(sample))).toEqual(sample);
    }
  });
});

describe("needsNextOwnerNudge", () => {
  it("is false when someone was mentioned", () => {
    expect(needsNextOwnerNudge("done", 1)).toBe(false);
  });

  it("is false when the loop closed with Agreed / Blocked / Proposed / Ready", () => {
    expect(needsNextOwnerNudge("Looks good.\nAgreed", 0)).toBe(false);
    expect(needsNextOwnerNudge("Blocked · no design", 0)).toBe(false);
    expect(needsNextOwnerNudge("Proposed · ship it", 0)).toBe(false);
    expect(needsNextOwnerNudge("Ready for you", 0)).toBe(false);
  });

  it("does not nudge successful replies without an English marker", () => {
    expect(needsNextOwnerNudge("Concluído. Os testes passaram e a correção está pronta.", 0)).toBe(
      false,
    );
    expect(needsNextOwnerNudge("I finished the toggle.", 0)).toBe(false);
    expect(needsNextOwnerNudge("", 0)).toBe(false);
  });

  it("does not infer a missing task delegation from a public handoff line", () => {
    expect(needsNextOwnerNudge("Handoff → @Builder · work", 0)).toBe(false);
  });
});

describe("findGroupCollabStatuses / lastGroupCollabStatus", () => {
  it("finds every status line and returns the last", () => {
    const body = ["Plan ready.", "Handoff → @Builder · impl", "Proposed · later"].join("\n");
    expect(findGroupCollabStatuses(body)).toHaveLength(2);
    expect(lastGroupCollabStatus(body)?.kind).toBe("proposed");
  });
});

describe("deriveGroupCollabStage", () => {
  it("maps status kinds to stage chips", () => {
    expect(stageFromCollabStatus({ kind: "handoff", targetName: "A", objective: "" })).toBe(
      "Handoff",
    );
    expect(stageFromCollabStatus({ kind: "proposed", summary: "x" })).toBe("Review");
    expect(stageFromCollabStatus({ kind: "agreed", note: "" })).toBe("Agree");
    expect(stageFromCollabStatus({ kind: "ready" })).toBe("Ready");
  });

  it("uses the latest collab status and resolves handoff owner by title", () => {
    const titles = new Map([["builder", "s-build"]]);
    const snap = deriveGroupCollabStage(
      [
        { body: "start" },
        { body: "Handoff → @Builder · toggle", authorSessionId: "s-lead", mentions: ["s-build"] },
      ],
      { titleToSessionId: titles },
    );
    expect(snap).toEqual({
      stage: "Handoff",
      ownerSessionId: "s-build",
      ownerName: "Builder",
    });
  });

  it("falls back to the running member as Handoff owner", () => {
    expect(deriveGroupCollabStage([], { runningSessionIds: ["s-lead"] })).toEqual({
      stage: "Handoff",
      ownerSessionId: "s-lead",
    });
  });

  it("resets the stage at the newest user task and ignores user-authored status text", () => {
    expect(
      deriveGroupCollabStage([
        { body: "Ready for you", authorKind: "agent", authorSessionId: "s-old" },
        { body: "Ready for you", authorKind: "user", kind: "message" },
      ]),
    ).toBeUndefined();
  });

  it("ignores a late status from a prior chain after the newest user task", () => {
    expect(
      deriveGroupCollabStage(
        [
          { id: "task-old", body: "old task", authorKind: "user" },
          { id: "task-new", body: "new task", authorKind: "user" },
          { body: "Ready for you", authorKind: "agent", chainId: "task-old" },
          { body: "Handoff → @Jennie 2 · review", authorKind: "agent", chainId: "task-new" },
        ],
        { titleToSessionId: new Map([["jennie 2", "s-review"]]) },
      ),
    ).toEqual({
      stage: "Handoff",
      ownerSessionId: "s-review",
      ownerName: "Jennie 2",
    });
    expect(
      deriveGroupCollabStage([
        { id: "task-new", body: "new task", authorKind: "user" },
        { body: "Ready for you", authorKind: "agent", chainId: "task-old" },
      ]),
    ).toBeUndefined();
  });

  it.each([
    { options: { runningSessionIds: ["s-active"] }, stage: "Handoff" },
    { options: { queuedSessionIds: ["s-active"] }, stage: "Handoff" },
    { options: { waitingSessionIds: ["s-active"] }, stage: "Review" },
  ])("prefers active member state over a stale Ready ($stage)", ({ options, stage }) => {
    expect(
      deriveGroupCollabStage(
        [{ body: "Ready for you", authorKind: "agent", authorSessionId: "s-old" }],
        options,
      ),
    ).toEqual({ stage, ownerSessionId: "s-active" });
  });

  it("derives active canonical message state within the current task", () => {
    expect(
      deriveGroupCollabStage([
        { id: "task-new", body: "new task", authorKind: "user" },
        {
          body: "",
          authorKind: "agent",
          authorSessionId: "s-active",
          chainId: "task-new",
          status: "writing",
        },
        { body: "Ready for you", authorKind: "agent", chainId: "task-new", status: "completed" },
      ]),
    ).toEqual({ stage: "Handoff", ownerSessionId: "s-active" });
  });

  it("ignores collab markers from failed or cancelled messages", () => {
    expect(
      deriveGroupCollabStage([
        { body: "Ready for you", authorKind: "agent", status: "failed" },
        { body: "Agreed", authorKind: "agent", status: "cancelled" },
      ]),
    ).toBeUndefined();
  });
});
