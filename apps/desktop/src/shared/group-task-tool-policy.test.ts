import { describe, expect, it } from "vitest";
import { groupTaskToolRequirements } from "./group-task-tool-policy";

const base = {
  kind: "code",
  stage: "implement",
  requiredCheckKinds: [],
  role: "owner",
  coordinator: false,
} as const;

describe("groupTaskToolRequirements", () => {
  it("requires reading and writing for code and docs implementation", () => {
    for (const kind of ["code", "docs"] as const) {
      expect(groupTaskToolRequirements({ ...base, kind }).requiredCapabilities).toEqual([
        "read",
        "write",
      ]);
    }
  });
  it("requires read capability for reviews including the reviewer role", () => {
    expect(groupTaskToolRequirements({ ...base, stage: "review" }).requiredCapabilities).toEqual([
      "read",
    ]);
    expect(groupTaskToolRequirements({ ...base, role: "reviewer" }).requiredCapabilities).toEqual([
      "read",
    ]);
  });
  it("requires shell only for verification with typed checks", () => {
    expect(
      groupTaskToolRequirements({
        ...base,
        stage: "verify",
        requiredCheckKinds: ["tests", "typecheck"],
      }).requiredCapabilities,
    ).toEqual(["shell"]);
    expect(groupTaskToolRequirements({ ...base, stage: "verify" }).requiredCapabilities).toEqual(
      [],
    );
  });
  it("requires network for research implementation", () => {
    expect(groupTaskToolRequirements({ ...base, kind: "research" }).requiredCapabilities).toEqual([
      "network",
    ]);
  });
  it("offers delegation tools only to coordinators", () => {
    const owner = groupTaskToolRequirements(base).groupToolNames;
    const reviewer = groupTaskToolRequirements({ ...base, role: "reviewer" }).groupToolNames;
    const coordinator = groupTaskToolRequirements({ ...base, coordinator: true }).groupToolNames;
    expect(owner).toContain("group_report_progress");
    expect(reviewer).toContain("group_review_task");
    for (const tool of ["group_assign_task", "group_handoff"]) {
      expect(owner).not.toContain(tool);
      expect(reviewer).not.toContain(tool);
      expect(coordinator).toContain(tool);
    }
  });
  it("offers result reporting only to task owners across task stages", () => {
    for (const stage of ["plan", "implement", "verify", "review", "deliver"] as const) {
      expect(groupTaskToolRequirements({ ...base, stage }).groupToolNames).toContain(
        "group_report_result",
      );
      expect(
        groupTaskToolRequirements({ ...base, stage, role: "reviewer" }).groupToolNames,
      ).not.toContain("group_report_result");
    }
  });
  it("does not infer requirements for legacy metadata", () => {
    expect(groupTaskToolRequirements({ ...base, kind: "legacy" })).toEqual({
      requiredCapabilities: [],
      groupToolNames: [],
    });
  });
});
