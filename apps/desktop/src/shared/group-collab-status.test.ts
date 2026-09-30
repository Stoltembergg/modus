import { describe, expect, it } from "vitest";
import {
  deriveGroupCollabStage,
  findGroupCollabStatuses,
  formatGroupCollabStatus,
  GROUP_COLLAB_NO_NEXT_OWNER,
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

  it("is true for silence or a handoff line without mentions", () => {
    expect(needsNextOwnerNudge("I finished the toggle.", 0)).toBe(true);
    expect(needsNextOwnerNudge("Handoff → @Builder · work", 0)).toBe(true);
    expect(GROUP_COLLAB_NO_NEXT_OWNER).toContain("@mention");
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
});
