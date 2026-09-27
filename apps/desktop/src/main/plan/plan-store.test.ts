import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPlanAcceptanceEvidenceById,
  deleteSessionPlan,
  hashContent,
  type PlanSpecWriteInput,
  readPlan,
  readPlanById,
  setPlanBuildStatusById,
  writePlan,
} from "./plan-store";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "modus-plan-root-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(overrides: Partial<Parameters<typeof writePlan>[1]> = {}) {
  return writePlan(root, {
    workspaceId: "ws-1",
    sessionId: "session-1",
    title: "Feat",
    overview: "Build the thing.",
    content: "# Feat\n\nDo a thing.",
    todos: [{ content: "Scaffold the project" }, { content: "Wire it up" }],
    ...overrides,
  });
}

describe("session plan persistence", () => {
  it("stores markdown content as plan.md and a single markdown block", () => {
    const plan = write({ content: "# Feature\n\nClient calls the router, then the store." });

    expect(plan.id).toBe("session-1");
    expect(plan.blocks).toEqual([
      { type: "markdown", content: "# Feature\n\nClient calls the router, then the store." },
    ]);
    expect(plan.hash).toBe(hashContent(plan.content));
    expect(readFileSync(plan.path, "utf8")).toContain("Client calls the router");
    expect(readPlan(root, "session-1")?.content).toContain("Client calls the router");
  });

  it("projects legacy visual blocks to markdown on read", () => {
    const dir = join(root, "session-legacy");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "plan.md");
    const body = "### Request flow\n\nClient calls the router, then the store.";
    writeFileSync(path, body, "utf8");
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({
        id: "session-legacy",
        sessionId: "session-legacy",
        workspaceId: "ws-1",
        title: "Legacy",
        overview: "Old visual plan.",
        path,
        blocks: [
          { type: "markdown", content: "# Feature" },
          {
            type: "visual",
            title: "Request flow",
            kind: "svg",
            content: "<svg><path /></svg>",
            fallback: "Client calls the router, then the store.",
          },
        ],
        todos: [],
        buildStatus: "not_built",
      }),
      "utf8",
    );

    const plan = readPlan(root, "session-legacy");
    expect(plan?.blocks).toEqual([
      { type: "markdown", content: "# Feature" },
      {
        type: "markdown",
        content: "### Request flow\n\nClient calls the router, then the store.",
      },
    ]);
    expect(plan?.content).toBe(body);
  });

  it("reads legacy plan metadata without a spec", () => {
    const dir = join(root, "session-legacy-spec");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "plan.md");
    writeFileSync(path, "# Legacy plan", "utf8");
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({ id: "session-legacy-spec", sessionId: "session-legacy-spec", path }),
      "utf8",
    );

    expect(readPlan(root, "session-legacy-spec")?.spec).toBeUndefined();
  });

  it("round-trips spec metadata, todo links, and evidence across build-status writes", () => {
    const spec: PlanSpecWriteInput = {
      requirements: [{ id: "req-auth", text: "Protect authenticated routes." }],
      acceptanceCriteria: [
        {
          id: "ac-auth",
          requirementId: "req-auth",
          description: "Unauthenticated requests are rejected.",
          todoIds: ["todo-guard"],
          requiredCheckKinds: ["tests", "typecheck"],
          status: "pending" as const,
        },
      ],
      assumptions: ["Existing session middleware remains authoritative."],
      openQuestions: ["Should expired tokens use a distinct response code?"],
    };
    const planWithoutEvidence = write({
      todos: [
        {
          id: "todo-guard",
          content: "Add the route guard",
          acceptanceCriterionIds: ["ac-auth"],
        },
      ],
      spec,
    });
    const updatedPlan = applyPlanAcceptanceEvidenceById(root, planWithoutEvidence.id, [
      {
        id: "evidence-test",
        criterionId: "ac-auth",
        kind: "check",
        status: "missing",
        label: "Tests",
      },
    ]);
    expect(updatedPlan).toBeDefined();
    if (!updatedPlan) throw new Error("Expected current-run QA evidence to update the plan.");
    const criterion = spec.acceptanceCriteria[0];
    if (!criterion) throw new Error("Expected a fixture acceptance criterion.");
    const plan = updatedPlan;
    const specWithEvidence = {
      ...spec,
      acceptanceCriteria: [{ ...criterion, status: "blocked" as const }],
      evidence: [
        {
          id: "evidence-test",
          criterionId: "ac-auth",
          kind: "check",
          status: "missing",
          label: "Tests",
        },
      ],
    };

    expect(plan.spec).toEqual(specWithEvidence);
    expect(plan.todos).toEqual([
      {
        id: "todo-guard",
        content: "Add the route guard",
        acceptanceCriterionIds: ["ac-auth"],
        status: "pending",
      },
    ]);
    expect(setPlanBuildStatusById(root, plan.id, "building")?.spec).toEqual(specWithEvidence);
    expect(readPlanById(root, plan.id)?.spec).toEqual(specWithEvidence);
  });

  it("updates checked criteria from linked current-run QA evidence", () => {
    const criteria = [
      ["ac-pass", "tests"],
      ["ac-fail", "typecheck"],
      ["ac-skip", "lint"],
      ["ac-block", "build"],
      ["ac-confirmed", "tests"],
      ["ac-manual", undefined],
    ] as const;
    const plan = write({
      todos: criteria.map(([id]) => ({ id: `todo-${id}`, content: `Implement ${id}` })),
      spec: {
        requirements: [{ id: "req", text: "Check criteria against real QA outcomes." }],
        acceptanceCriteria: criteria.map(([id, requiredCheckKinds]) => ({
          id,
          requirementId: "req",
          description: `Criterion ${id}`,
          todoIds: [`todo-${id}`],
          ...(requiredCheckKinds ? { requiredCheckKinds: [requiredCheckKinds] } : {}),
          status: "pending",
        })),
        assumptions: [],
        openQuestions: [],
      },
    });
    const evidence = [
      ["ac-pass", "Tests", "passed"],
      ["ac-fail", "Typecheck", "failed"],
      ["ac-skip", "Lint", "skipped"],
      ["ac-block", "Build", "unavailable"],
      ["ac-confirmed", "Tests", "user_confirmed"],
    ] as const;

    const updated = applyPlanAcceptanceEvidenceById(
      root,
      plan.id,
      evidence.map(([criterionId, label, status], index) => ({
        id: `qa-evidence-${index}`,
        criterionId,
        kind: "check",
        status,
        runId: "current-run",
        label,
      })),
    );

    expect(updated?.spec?.acceptanceCriteria.map(({ id, status }) => [id, status])).toEqual([
      ["ac-pass", "passed"],
      ["ac-fail", "failed"],
      ["ac-skip", "skipped"],
      ["ac-block", "blocked"],
      ["ac-confirmed", "blocked"],
      ["ac-manual", "pending"],
    ]);
    expect(updated?.spec?.evidence).toHaveLength(5);
    expect(readPlan(root, plan.sessionId)?.spec).toEqual(updated?.spec);
  });

  it("rejects unlinked and duplicate references on QA evidence updates", () => {
    const plan = write({
      todos: [{ id: "todo", content: "Check" }],
      spec: {
        requirements: [{ id: "req", text: "Requirement" }],
        acceptanceCriteria: [
          {
            id: "ac",
            requirementId: "req",
            description: "Checked criterion",
            todoIds: ["todo"],
            requiredCheckKinds: ["tests"],
            status: "pending",
          },
        ],
        assumptions: [],
        openQuestions: [],
      },
    });
    const evidence = {
      id: "qa-reference",
      kind: "check",
      status: "passed" as const,
      label: "Tests",
    };

    expect(() =>
      applyPlanAcceptanceEvidenceById(root, plan.id, [{ ...evidence, criterionId: "unknown" }]),
    ).toThrow("unknown acceptance criterion");
    expect(() =>
      applyPlanAcceptanceEvidenceById(root, plan.id, [
        { ...evidence, criterionId: "ac" },
        { ...evidence, criterionId: "ac" },
      ]),
    ).toThrow("IDs must be unique");
  });

  it("leaves checked criteria with no linked todos pending during QA updates", () => {
    const plan = write({
      todos: [],
      spec: {
        requirements: [{ id: "req", text: "Requirement" }],
        acceptanceCriteria: [
          {
            id: "ac-unlinked",
            requirementId: "req",
            description: "No implementation todo is linked.",
            todoIds: [],
            requiredCheckKinds: ["tests"],
            status: "pending",
          },
        ],
        assumptions: [],
        openQuestions: [],
      },
    });

    const updated = applyPlanAcceptanceEvidenceById(root, plan.id, [
      {
        id: "qa-unlinked",
        criterionId: "ac-unlinked",
        kind: "check",
        status: "passed",
        label: "Tests",
      },
    ]);

    expect(updated?.spec?.acceptanceCriteria[0]?.status).toBe("pending");
    expect(updated?.spec?.evidence).toEqual([]);
  });

  it("updates QA for a criterion linked only from the todo side", () => {
    const plan = write({
      todos: [
        {
          id: "todo-reciprocal",
          content: "Implement check",
          acceptanceCriterionIds: ["ac-reciprocal"],
        },
      ],
      spec: {
        requirements: [{ id: "req", text: "Requirement" }],
        acceptanceCriteria: [
          {
            id: "ac-reciprocal",
            requirementId: "req",
            description: "Todo-side-only link is valid.",
            todoIds: [],
            requiredCheckKinds: ["tests"],
            status: "pending",
          },
        ],
        assumptions: [],
        openQuestions: [],
      },
    });

    const updated = applyPlanAcceptanceEvidenceById(root, plan.id, [
      {
        id: "qa-reciprocal",
        criterionId: "ac-reciprocal",
        kind: "check",
        status: "passed",
        label: "Tests",
      },
    ]);

    expect(updated?.spec?.acceptanceCriteria[0]?.status).toBe("passed");
    expect(updated?.spec?.evidence).toEqual([
      expect.objectContaining({ id: "qa-reciprocal", criterionId: "ac-reciprocal" }),
    ]);
  });

  it("initializes Spec evidence empty even if an untyped writer supplies evidence", () => {
    const spec = {
      requirements: [{ id: "req", text: "Requirement" }],
      acceptanceCriteria: [
        {
          id: "ac",
          requirementId: "req",
          description: "Checked criterion",
          todoIds: ["todo"],
          requiredCheckKinds: ["tests"],
          status: "pending" as const,
        },
      ],
      assumptions: [],
      openQuestions: [],
      evidence: [
        {
          id: "model-passed",
          criterionId: "ac",
          kind: "check",
          status: "passed" as const,
          label: "Tests",
        },
      ],
    };
    const plan = write({
      todos: [{ id: "todo", content: "Check" }],
      spec: spec as unknown as PlanSpecWriteInput,
    });

    expect(plan.spec?.evidence).toEqual([]);
  });

  it("blocks a multi-check criterion when any required check is missing", () => {
    const plan = write({
      todos: [
        {
          id: "todo-multi",
          content: "Complete all verification",
          acceptanceCriterionIds: ["ac-multi"],
        },
      ],
      spec: {
        requirements: [{ id: "req", text: "Run every linked check." }],
        acceptanceCriteria: [
          {
            id: "ac-multi",
            requirementId: "req",
            description: "Both checks are available.",
            todoIds: ["todo-multi"],
            requiredCheckKinds: ["tests", "typecheck"],
            status: "pending",
          },
        ],
        assumptions: [],
        openQuestions: [],
      },
    });

    const updated = applyPlanAcceptanceEvidenceById(root, plan.id, [
      {
        id: "qa-test-skipped",
        criterionId: "ac-multi",
        kind: "check",
        status: "skipped",
        label: "Tests",
      },
    ]);

    expect(updated?.spec?.acceptanceCriteria[0]?.status).toBe("blocked");
  });

  it("recomputes every checked criterion from each fresh Build run and preserves evidence history", () => {
    const criterionData = [
      ["ac-retry", ["tests"]],
      ["ac-mutation", ["typecheck"]],
      ["ac-missing", ["lint"]],
      ["ac-multi", ["tests", "typecheck"]],
    ] as const;
    const plan = write({
      todos: criterionData.map(([id]) => ({ id: `todo-${id}`, content: `Work on ${id}` })),
      spec: {
        requirements: [{ id: "req", text: "Statuses are scoped to the latest build." }],
        acceptanceCriteria: criterionData.map(([id, requiredCheckKinds]) => ({
          id,
          requirementId: "req",
          description: id,
          todoIds: [`todo-${id}`],
          requiredCheckKinds: [...requiredCheckKinds],
          status: "pending",
        })),
        assumptions: [],
        openQuestions: [],
      },
    });
    const applyRun = (
      runId: string,
      entries: Array<[string, string, "passed" | "failed" | "skipped" | "missing"]>,
    ) =>
      applyPlanAcceptanceEvidenceById(
        root,
        plan.id,
        entries.map(([criterionId, label, status], index) => ({
          id: `${runId}-evidence-${index}`,
          criterionId,
          kind: "check",
          status,
          runId,
          label,
        })),
      );

    applyRun("build-one", [
      ["ac-retry", "Tests", "failed"],
      ["ac-mutation", "Typecheck", "passed"],
      ["ac-missing", "Lint", "passed"],
      ["ac-multi", "Tests", "passed"],
      ["ac-multi", "Typecheck", "passed"],
    ]);
    const secondRun = applyRun("build-two", [
      ["ac-retry", "Tests", "passed"],
      ["ac-mutation", "Typecheck", "failed"],
      ["ac-multi", "Tests", "passed"],
    ]);

    expect(secondRun?.spec?.acceptanceCriteria.map(({ id, status }) => [id, status])).toEqual([
      ["ac-retry", "passed"],
      ["ac-mutation", "failed"],
      ["ac-missing", "blocked"],
      ["ac-multi", "blocked"],
    ]);
    expect(secondRun?.spec?.evidence).toHaveLength(8);
    expect(secondRun?.spec?.evidence.filter((item) => item.runId === "build-two")).toHaveLength(3);
  });

  it("retains every current-run reference at the maximum criterion/check capacity", () => {
    const checkKinds = ["tests", "typecheck", "lint", "build"] as const;
    const labels = {
      tests: "Tests",
      typecheck: "Typecheck",
      lint: "Lint",
      build: "Build",
    } as const;
    const criterionCount = 100;
    const plan = write({
      todos: Array.from({ length: criterionCount }, (_, index) => ({
        id: `todo-${index}`,
        content: `Implement ${index}`,
      })),
      spec: {
        requirements: [{ id: "req", text: "Verify maximum-size plan." }],
        acceptanceCriteria: Array.from({ length: criterionCount }, (_, index) => ({
          id: `ac-${index}`,
          requirementId: "req",
          description: `Criterion ${index}`,
          todoIds: [`todo-${index}`],
          requiredCheckKinds: [...checkKinds],
          status: "pending" as const,
        })),
        assumptions: [],
        openQuestions: [],
      },
    });
    const makeEvidence = (
      runId: string,
      statusFor: (
        criterionIndex: number,
        checkIndex: number,
      ) => "passed" | "failed" | "skipped" | "unavailable",
    ) =>
      Array.from({ length: criterionCount }, (_, criterionIndex) =>
        checkKinds.map((kind, checkIndex) => ({
          id: `${runId}-evidence-${criterionIndex}-${kind}`,
          criterionId: `ac-${criterionIndex}`,
          kind: "check",
          status: statusFor(criterionIndex, checkIndex),
          runId,
          label: labels[kind],
        })),
      ).flat();
    const firstRunEvidence = makeEvidence("max-run-one", () => "passed");
    const firstRun = applyPlanAcceptanceEvidenceById(root, plan.id, firstRunEvidence);
    expect(firstRun?.spec?.evidence).toHaveLength(400);

    const secondRunEvidence = makeEvidence("max-run-two", (criterionIndex, checkIndex) => {
      if (criterionIndex % 4 === 0) return "passed";
      if (criterionIndex % 4 === 1 && checkIndex === 0) return "failed";
      if (criterionIndex % 4 === 2 && checkIndex === 0) return "skipped";
      if (criterionIndex % 4 === 3 && checkIndex === 0) return "unavailable";
      return "passed";
    });
    const secondRun = applyPlanAcceptanceEvidenceById(root, plan.id, secondRunEvidence);
    const persistedEvidence = secondRun?.spec?.evidence ?? [];

    expect(persistedEvidence).toHaveLength(800);
    expect(persistedEvidence.filter((reference) => reference.runId === "max-run-two")).toHaveLength(
      400,
    );
    expect(persistedEvidence.map((reference) => reference.id)).toEqual(
      expect.arrayContaining(secondRunEvidence.map((reference) => reference.id)),
    );
    expect(secondRun?.spec?.acceptanceCriteria.map(({ status }) => status)).toEqual(
      Array.from({ length: criterionCount }, (_, index) =>
        index % 4 === 0
          ? "passed"
          : index % 4 === 1
            ? "failed"
            : index % 4 === 2
              ? "skipped"
              : "blocked",
      ),
    );
  });

  it.each([
    ["more than 100 acceptance criteria", 101, ["tests"]],
    ["more than four check kinds", 1, ["tests", "typecheck", "lint", "build", "tests"]],
  ] as const)("bounds persisted spec size for %s", (_label, criterionCount, requiredCheckKinds) => {
    const todos = Array.from({ length: criterionCount }, (_, index) => ({
      id: `todo-${index}`,
      content: `Implement ${index}`,
    }));
    expect(() =>
      write({
        todos,
        spec: {
          requirements: [{ id: "req", text: "Bound the persisted plan." }],
          acceptanceCriteria: Array.from({ length: criterionCount }, (_, index) => ({
            id: `ac-${index}`,
            requirementId: "req",
            description: `Criterion ${index}`,
            todoIds: [`todo-${index}`],
            requiredCheckKinds: [...requiredCheckKinds],
            status: "pending" as const,
          })),
          assumptions: [],
          openQuestions: [],
        },
      }),
    ).toThrow();
  });

  it.each([
    ["empty requirement ID", { requirements: [{ id: " ", text: "Requirement" }] }],
    [
      "duplicate requirement IDs",
      {
        requirements: [
          { id: "req", text: "One" },
          { id: "req", text: "Two" },
        ],
      },
    ],
    [
      "overlong criterion ID",
      {
        acceptanceCriteria: [
          { id: "a".repeat(129), requirementId: "req", description: "Criterion", todoIds: [] },
        ],
      },
    ],
    [
      "unknown requirement reference",
      {
        acceptanceCriteria: [
          { id: "ac", requirementId: "missing", description: "Criterion", todoIds: [] },
        ],
      },
    ],
    [
      "unknown todo link",
      {
        acceptanceCriteria: [
          { id: "ac", requirementId: "req", description: "Criterion", todoIds: ["missing"] },
        ],
      },
    ],
    ["unknown criterion todo link", { todoAcceptanceCriterionIds: ["missing"] }],
    [
      "unsupported required check kind",
      {
        acceptanceCriteria: [
          {
            id: "ac",
            requirementId: "req",
            description: "Criterion",
            todoIds: [],
            requiredCheckKinds: ["security"],
          },
        ],
      },
    ],
    [
      "non-pending new criterion status",
      {
        acceptanceCriteria: [
          {
            id: "ac",
            requirementId: "req",
            description: "Criterion",
            todoIds: [],
            status: "passed",
          },
        ],
      },
    ],
  ] as const)("rejects invalid spec metadata: %s", (_label, invalid) => {
    const validSpec = {
      requirements: [{ id: "req", text: "Requirement" }],
      acceptanceCriteria: [
        { id: "ac", requirementId: "req", description: "Criterion", todoIds: ["todo"] },
      ],
      assumptions: [],
      openQuestions: [],
    };
    const todo = {
      id: "todo",
      content: "Implement criterion",
      acceptanceCriterionIds: ["ac"],
    };
    const spec = { ...validSpec, ...invalid };
    const todos =
      "todoAcceptanceCriterionIds" in invalid
        ? [{ ...todo, acceptanceCriterionIds: invalid.todoAcceptanceCriterionIds }]
        : [todo];
    const normalizedSpec = { ...spec };
    delete (normalizedSpec as { todoAcceptanceCriterionIds?: unknown }).todoAcceptanceCriterionIds;

    const invalidInput = {
      workspaceId: "ws-1",
      sessionId: "session-invalid-spec",
      title: "Invalid spec",
      overview: "Invalid raw metadata fixture.",
      content: "# Invalid spec",
      todos,
      spec: normalizedSpec,
    };
    expect(() =>
      writePlan(root, invalidInput as unknown as Parameters<typeof writePlan>[1]),
    ).toThrow();
  });

  it("isolates equal plan titles by session and rewrites only the owning session", () => {
    const first = write();
    const other = write({ sessionId: "session-2" });
    const revised = write({
      content: "# Revised",
    });

    expect(revised.path).toBe(first.path);
    expect(other.path).not.toBe(first.path);
    expect(readPlan(root, "session-1")?.content).toBe("# Revised");
    expect(readPlan(root, "session-2")?.content).toContain("# Feat");
  });

  it("derives stable unique todo ids and resets build status on revision", () => {
    const plan = write({
      todos: [{ content: "Same step" }, { content: "Same step" }],
    });
    expect(new Set(plan.todos.map((todo) => todo.id)).size).toBe(2);
    expect(setPlanBuildStatusById(root, plan.id, "built")?.buildStatus).toBe("built");
    expect(write().buildStatus).toBe("not_built");
  });

  it("deletes the plan with its session", () => {
    write();
    deleteSessionPlan(root, "session-1");
    expect(readPlan(root, "session-1")).toBeUndefined();
  });

  it("also removes a historical workspace-scoped plan owned by the session", () => {
    const legacyDir = join(root, "workspace", "feature");
    const path = join(legacyDir, "plan.md");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path, "# Legacy", "utf8");
    writeFileSync(
      join(legacyDir, "plan.json"),
      JSON.stringify({ id: "workspace:feature", sessionId: "session-1", path }),
      "utf8",
    );

    deleteSessionPlan(root, "session-1");
    expect(existsSync(legacyDir)).toBe(false);
  });
});

describe("build status transitions", () => {
  it("transitions through building and built by session id", () => {
    const plan = write();
    expect(setPlanBuildStatusById(root, plan.id, "building")?.buildStatus).toBe("building");
    expect(setPlanBuildStatusById(root, plan.id, "built")?.buildStatus).toBe("built");
    expect(readPlanById(root, plan.id)?.buildStatus).toBe("built");
  });

  it("returns undefined for a missing plan", () => {
    expect(setPlanBuildStatusById(root, "missing", "built")).toBeUndefined();
    expect(readPlanById(root, "missing")).toBeUndefined();
  });
});
