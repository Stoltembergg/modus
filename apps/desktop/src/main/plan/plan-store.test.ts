import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsFailures = vi.hoisted(() => ({
  renameCalls: 0,
  renameFailCalls: [] as number[],
  markerWriteFails: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      fsFailures.renameCalls += 1;
      if (fsFailures.renameFailCalls.includes(fsFailures.renameCalls)) {
        throw new Error(`rename failure ${fsFailures.renameCalls}`);
      }
      return actual.renameSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsFailures.markerWriteFails && String(args[0]).endsWith("hyperplan-revision-in-doubt")) {
        throw new Error("marker write failed");
      }
      return actual.writeFileSync(...args);
    },
  };
});

import {
  applyPlanAcceptanceEvidenceById,
  deleteSessionPlan,
  fingerprintPlanSource,
  hashContent,
  type PlanSpecWriteInput,
  promotePlanRevision,
  readPlan,
  readPlanById,
  setPlanBuildStatusById,
  updatePlanContentById,
  writePlan,
} from "./plan-store";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "modus-plan-root-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fsFailures.renameCalls = 0;
  fsFailures.renameFailCalls = [];
  fsFailures.markerWriteFails = false;
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

  it("updates only markdown content while preserving Spec, todos, metadata, and build status", () => {
    const planWithoutEvidence = write({
      todos: [
        { id: "todo-guard", content: "Add the route guard", acceptanceCriterionIds: ["ac-auth"] },
      ],
      spec: {
        requirements: [{ id: "req-auth", text: "Protect authenticated routes." }],
        acceptanceCriteria: [
          {
            id: "ac-auth",
            requirementId: "req-auth",
            description: "Reject unauthenticated requests.",
            todoIds: ["todo-guard"],
            requiredCheckKinds: ["tests"],
            status: "pending",
          },
        ],
        assumptions: ["Keep current middleware."],
        openQuestions: ["Which error code?"],
      },
    });
    const evidenced = applyPlanAcceptanceEvidenceById(root, planWithoutEvidence.id, [
      {
        id: "evidence-test",
        criterionId: "ac-auth",
        kind: "check",
        status: "passed",
        label: "Tests",
      },
    ]);
    if (!evidenced) throw new Error("Expected plan evidence to persist.");
    const original = setPlanBuildStatusById(root, evidenced.id, "built");
    if (!original) throw new Error("Expected plan build status to persist.");

    const updated = updatePlanContentById(root, original.id, original.hash, "# Revised");

    const { updatedAt: _updatedAt, ...originalWithoutTimestamp } = original;
    expect(updated).toMatchObject({
      ...originalWithoutTimestamp,
      content: "# Revised",
      hash: hashContent("# Revised"),
      blocks: [{ type: "markdown", content: "# Revised" }],
    });
    expect(Number.isNaN(Date.parse(updated?.updatedAt ?? ""))).toBe(false);
    expect(updated?.spec).toEqual(original.spec);
    expect(updated?.todos).toEqual(original.todos);
    expect(updated?.title).toBe(original.title);
    expect(updated?.overview).toBe(original.overview);
    expect(updated?.path).toBe(original.path);
    expect(updated?.buildStatus).toBe(original.buildStatus);
    expect(readPlanById(root, original.id)).toEqual(updated);
  });

  it("rejects stale plan hashes without changing the stored body", () => {
    const plan = write();

    expect(() => updatePlanContentById(root, plan.id, "stale-hash", "# Revised")).toThrow(
      "Plan changed",
    );
    expect(readPlanById(root, plan.id)?.content).toBe(plan.content);
  });

  it("rejects an externally edited body even when metadata retains the expected hash", () => {
    const plan = write();
    writeFileSync(plan.path, "# External edit", "utf8");

    expect(() => updatePlanContentById(root, plan.id, plan.hash, "# Revised")).toThrow(
      "Plan changed",
    );
    expect(readFileSync(plan.path, "utf8")).toBe("# External edit");
  });

  it("restores body and metadata when the after-persist callback fails", () => {
    const plan = write();
    const metadataPath = join(root, plan.id, "plan.json");
    const previousMetadata = readFileSync(metadataPath);
    const failure = new Error("event persistence failed");

    expect(() =>
      updatePlanContentById(root, plan.id, plan.hash, "# Revised", () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(readFileSync(plan.path, "utf8")).toBe(plan.content);
    expect(readFileSync(metadataPath)).toEqual(previousMetadata);
    expect(readPlanById(root, plan.id)).toEqual(plan);
  });

  it("refuses revisions while the in-doubt marker exists", () => {
    const plan = write();
    writeFileSync(join(root, plan.id, "hyperplan-revision-in-doubt"), "manual repair required");

    expect(() => updatePlanContentById(root, plan.id, plan.hash, "# Revised")).toThrow(
      /indeterminate|in-doubt/i,
    );
    expect(readFileSync(plan.path, "utf8")).toBe(plan.content);
  });

  it("allows revisions after manual repair and marker removal", () => {
    const plan = write();
    const markerPath = join(root, plan.id, "hyperplan-revision-in-doubt");
    fsFailures.renameFailCalls = [2, 3];

    expect(() => updatePlanContentById(root, plan.id, plan.hash, "# Revised")).toThrow(
      /indeterminate/i,
    );
    expect(existsSync(markerPath)).toBe(true);

    fsFailures.renameFailCalls = [];
    writeFileSync(plan.path, plan.content, "utf8");
    rmSync(markerPath);

    expect(updatePlanContentById(root, plan.id, plan.hash, "# Repaired")).toMatchObject({
      content: "# Repaired",
    });
  });

  it.each([
    ["Markdown replacement", [1]],
    ["metadata replacement", [2]],
  ] as const)("restores both files when %s rename fails", (_stage, failedCalls) => {
    const plan = write();
    const metadataPath = join(root, plan.id, "plan.json");
    const originalMetadata = readFileSync(metadataPath);
    fsFailures.renameFailCalls = [...failedCalls];

    expect(() => updatePlanContentById(root, plan.id, plan.hash, "# Revised")).toThrow(
      "rename failure",
    );
    expect(readFileSync(plan.path, "utf8")).toBe(plan.content);
    expect(readFileSync(metadataPath)).toEqual(originalMetadata);
    expect(existsSync(join(root, plan.id, "hyperplan-revision-in-doubt"))).toBe(false);
  });

  it.each([
    ["Markdown rollback", [3]],
    ["both rollbacks", [3, 4]],
  ] as const)("marks state indeterminate when %s fails", (_stage, failedCalls) => {
    const plan = write();
    fsFailures.renameFailCalls = [...failedCalls];

    expect(() =>
      updatePlanContentById(root, plan.id, plan.hash, "# Revised", () => {
        throw new Error("event failed");
      }),
    ).toThrow(/indeterminate/i);
    expect(existsSync(join(root, plan.id, "hyperplan-revision-in-doubt"))).toBe(true);
    expect(() => updatePlanContentById(root, plan.id, plan.hash, "# Second revision")).toThrow(
      /indeterminate|in-doubt/i,
    );
  });

  it("keeps an in-memory update latch when rollback and marker creation both fail", () => {
    const plan = write();
    fsFailures.renameFailCalls = [3];
    fsFailures.markerWriteFails = true;

    expect(() =>
      updatePlanContentById(root, plan.id, plan.hash, "# Revised", () => {
        throw new Error("event failed");
      }),
    ).toThrow(/indeterminate/i);
    expect(existsSync(join(root, plan.id, "hyperplan-revision-in-doubt"))).toBe(false);
    expect(() => updatePlanContentById(root, plan.id, plan.hash, "# Second revision")).toThrow(
      /indeterminate|in-doubt/i,
    );
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

describe("HyperPlan revision promotion", () => {
  const revision = {
    title: "Revised",
    overview: "A safer plan.",
    content: "# Revised\n\nImplement carefully.",
    todos: [{ id: "todo-new", content: "Implement", acceptanceCriterionIds: ["ac-new"] }],
    spec: {
      requirements: [{ id: "req-new", text: "Ship safely." }],
      acceptanceCriteria: [
        {
          id: "ac-new",
          requirementId: "req-new",
          description: "Checks pass.",
          todoIds: ["todo-new"],
          requiredCheckKinds: ["tests" as const],
        },
      ],
      assumptions: ["CI is available."],
      openQuestions: ["Which release date?"],
    },
  };

  it("fingerprints all source fields canonically while preserving array order", () => {
    const plan = write({
      todos: [
        { id: "todo-a", content: "A" },
        { id: "todo-b", content: "B" },
      ],
      spec: {
        requirements: [
          { id: "req-a", text: "A" },
          { id: "req-b", text: "B" },
        ],
        acceptanceCriteria: [],
        assumptions: ["a", "b"],
        openQuestions: [],
      },
    });
    const spec = plan.spec;
    if (!spec) throw new Error("Expected the fixture plan to include a spec.");
    const source = {
      title: plan.title,
      overview: plan.overview,
      content: plan.content,
      todos: plan.todos,
      spec,
    };
    expect(fingerprintPlanSource(source)).toBe(
      fingerprintPlanSource({ ...source, todos: [...source.todos] }),
    );
    expect(fingerprintPlanSource(source)).not.toBe(
      fingerprintPlanSource({ ...source, title: "Other" }),
    );
    expect(fingerprintPlanSource(source)).not.toBe(
      fingerprintPlanSource({ ...source, todos: [...source.todos].reverse() }),
    );
    expect(fingerprintPlanSource(source)).not.toBe(
      fingerprintPlanSource({ ...source, spec: { ...source.spec, assumptions: ["b", "a"] } }),
    );
  });

  it("treats missing legacy Spec evidence as equivalent to empty evidence", () => {
    const plan = write({
      spec: {
        requirements: [{ id: "req-legacy", text: "Keep legacy plans readable." }],
        acceptanceCriteria: [],
        assumptions: [],
        openQuestions: [],
      },
    });
    if (!plan.spec) throw new Error("Expected the fixture plan to include a spec.");
    const { evidence: _evidence, ...legacySpec } = plan.spec;
    const legacySource = { ...plan, spec: legacySpec } as unknown as typeof plan;

    expect(fingerprintPlanSource(legacySource)).toBe(
      fingerprintPlanSource({ ...plan, spec: { ...plan.spec, evidence: [] } }),
    );
  });

  it("promotes matching source coherently and resets all build/QA state", () => {
    const original = write({
      todos: [{ id: "old", content: "Old work" }],
      spec: {
        requirements: [{ id: "old-req", text: "Old" }],
        acceptanceCriteria: [
          {
            id: "old-ac",
            requirementId: "old-req",
            description: "Old",
            todoIds: [],
            requiredCheckKinds: ["tests"],
            status: "pending",
          },
        ],
        assumptions: [],
        openQuestions: [],
      },
    });
    applyPlanAcceptanceEvidenceById(root, original.id, [
      {
        id: "old-evidence",
        criterionId: "old-ac",
        kind: "check",
        status: "passed",
        label: "Tests",
      },
    ]);
    setPlanBuildStatusById(root, original.id, "built");
    const current = readPlanById(root, original.id);
    if (!current) throw new Error("Expected the original plan to be readable.");
    const promoted = promotePlanRevision(root, {
      planId: original.id,
      expectedFingerprint: fingerprintPlanSource(current),
      revision,
    });

    expect(promoted.title).toBe(revision.title);
    expect(promoted.todos).toEqual([{ ...revision.todos[0], status: "pending" }]);
    expect(promoted.spec?.acceptanceCriteria).toEqual([
      { ...revision.spec.acceptanceCriteria[0], status: "pending" },
    ]);
    expect(promoted.spec?.evidence).toEqual([]);
    expect(promoted.buildStatus).toBe("not_built");
    expect(promoted.hash).toBe(hashContent(revision.content.trim()));
    expect(readFileSync(promoted.path, "utf8")).toBe(promoted.content);
    expect(readPlanById(root, original.id)).toEqual(promoted);
    expect(JSON.parse(readFileSync(join(root, original.id, "plan.json"), "utf8"))).toMatchObject({
      title: promoted.title,
      hash: promoted.hash,
    });
  });

  it("rejects stale source without changing the plan", () => {
    const plan = write();
    const before = readPlanById(root, plan.id);
    if (!before) throw new Error("Expected the plan to be readable before promotion.");
    expect(() =>
      promotePlanRevision(root, { planId: plan.id, expectedFingerprint: "stale", revision }),
    ).toThrow(/changed/i);
    expect(readPlanById(root, plan.id)).toEqual(before);
  });

  it("revalidates the source after staging detects a change before publication", () => {
    const plan = write();
    const current = readPlanById(root, plan.id);
    if (!current) throw new Error("Expected the plan to be readable before promotion.");
    const originalRename = fs.renameSync;
    const markerRename = vi.spyOn(fs, "renameSync");
    let changedDuringStaging = false;
    markerRename.mockImplementation(((from: fs.PathLike, to: fs.PathLike, ...args: unknown[]) => {
      const result = (originalRename as (...renameArgs: unknown[]) => void)(from, to, ...args);
      if (String(to).endsWith(".plan-transaction.json") && !changedDuringStaging) {
        changedDuringStaging = true;
        fs.writeFileSync(plan.path, "# Changed during staging", "utf8");
      }
      return result;
    }) as typeof fs.renameSync);
    try {
      expect(() =>
        promotePlanRevision(root, {
          planId: plan.id,
          expectedFingerprint: fingerprintPlanSource(current),
          revision,
        }),
      ).toThrow(/source changed/i);
    } finally {
      markerRename.mockRestore();
    }
    expect(readFileSync(plan.path, "utf8")).toBe("# Changed during staging");
    expect(readPlanById(root, plan.id)?.title).toBe(plan.title);
  });

  it("rolls back both authoritative files after a publication failure", () => {
    const plan = write();
    const before = readPlanById(root, plan.id);
    if (!before) throw new Error("Expected the plan to be readable before promotion.");
    const originalMarkdown = readFileSync(before.path);
    const originalMeta = readFileSync(join(root, plan.id, "plan.json"));
    const originalRename = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync");
    rename.mockImplementation(((from: fs.PathLike, to: fs.PathLike, ...args: unknown[]) => {
      if (String(to).endsWith("plan.json")) throw new Error("injected publication failure");
      return (originalRename as (...args: unknown[]) => void)(from, to, ...args);
    }) as typeof fs.renameSync);
    try {
      expect(() =>
        promotePlanRevision(root, {
          planId: plan.id,
          expectedFingerprint: fingerprintPlanSource(before),
          revision,
        }),
      ).toThrow("injected publication failure");
    } finally {
      rename.mockRestore();
    }
    expect(readFileSync(before.path)).toEqual(originalMarkdown);
    expect(readFileSync(join(root, plan.id, "plan.json"))).toEqual(originalMeta);
    expect(readPlanById(root, plan.id)).toEqual(before);
    expect(readFileSync(before.path, "utf8")).toBe(before.content);
    expect(readFileSync(join(root, plan.id, "plan.json"))).toEqual(originalMeta);
  });

  it("recovers the previous plan from an interrupted transaction marker", () => {
    const plan = write();
    const dir = join(root, plan.id);
    const originalMarkdown = readFileSync(plan.path);
    const originalMeta = readFileSync(join(dir, "plan.json"));
    const suffix = "123e4567-e89b-12d3-a456-426614174000";
    const transaction = {
      state: "prepared",
      backupMarkdown: `.plan.md.${suffix}.backup`,
      backupMeta: `.plan.json.${suffix}.backup`,
      stagedMarkdown: `.plan.md.${suffix}.stage`,
      stagedMeta: `.plan.json.${suffix}.stage`,
    };
    writeFileSync(join(dir, transaction.backupMarkdown), originalMarkdown);
    writeFileSync(join(dir, transaction.backupMeta), originalMeta);
    // Replace both published files with a partial/new state and leave the recovery marker.
    writeFileSync(plan.path, "# Interrupted", "utf8");
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({ id: plan.id, sessionId: plan.id, path: plan.path, title: "Interrupted" }),
      "utf8",
    );
    writeFileSync(join(dir, ".plan-transaction.json"), JSON.stringify(transaction), "utf8");

    expect(readPlanById(root, plan.id)?.content).toBe(plan.content);
    expect(readFileSync(plan.path)).toEqual(originalMarkdown);
    expect(readFileSync(join(dir, "plan.json"))).toEqual(originalMeta);
    expect(existsSync(join(dir, ".plan-transaction.json"))).toBe(false);
  });

  it("keeps committed revision bytes and removes its recovery marker", () => {
    const plan = write();
    const current = readPlanById(root, plan.id);
    if (!current) throw new Error("Expected the plan to be readable before promotion.");
    promotePlanRevision(root, {
      planId: plan.id,
      expectedFingerprint: fingerprintPlanSource(current),
      revision,
    });
    const dir = join(root, plan.id);
    const revisionMarkdown = readFileSync(plan.path);
    const revisionMeta = readFileSync(join(dir, "plan.json"));
    const suffix = "123e4567-e89b-12d3-a456-426614174000";
    const transaction = {
      state: "committed",
      backupMarkdown: `.plan.md.${suffix}.backup`,
      backupMeta: `.plan.json.${suffix}.backup`,
      stagedMarkdown: `.plan.md.${suffix}.stage`,
      stagedMeta: `.plan.json.${suffix}.stage`,
    };
    writeFileSync(join(dir, transaction.backupMarkdown), "old markdown");
    writeFileSync(join(dir, transaction.backupMeta), "old metadata");
    writeFileSync(join(dir, transaction.stagedMarkdown), "staged markdown");
    writeFileSync(join(dir, transaction.stagedMeta), "staged metadata");
    writeFileSync(join(dir, ".plan-transaction.json"), JSON.stringify(transaction));

    expect(readPlanById(root, plan.id)?.title).toBe(revision.title);
    expect(readFileSync(plan.path)).toEqual(revisionMarkdown);
    expect(readFileSync(join(dir, "plan.json"))).toEqual(revisionMeta);
    expect(existsSync(join(dir, ".plan-transaction.json"))).toBe(false);
    expect(existsSync(join(dir, transaction.backupMarkdown))).toBe(false);
  });

  it.each([
    "backupMarkdown",
    "backupMeta",
    "stagedMarkdown",
    "stagedMeta",
  ] as const)("recovers prepared state idempotently if cleanup fails removing %s", (failedArtifact) => {
    const plan = write();
    const dir = join(root, plan.id);
    const originalMarkdown = readFileSync(plan.path);
    const originalMeta = readFileSync(join(dir, "plan.json"));
    const suffix = "123e4567-e89b-12d3-a456-426614174000";
    const transaction = {
      state: "prepared",
      backupMarkdown: `.plan.md.${suffix}.backup`,
      backupMeta: `.plan.json.${suffix}.backup`,
      stagedMarkdown: `.plan.md.${suffix}.stage`,
      stagedMeta: `.plan.json.${suffix}.stage`,
    };
    for (const key of ["backupMarkdown", "backupMeta", "stagedMarkdown", "stagedMeta"] as const) {
      writeFileSync(join(dir, transaction[key]), "transaction artifact");
    }
    writeFileSync(join(dir, transaction.backupMarkdown), originalMarkdown);
    writeFileSync(join(dir, transaction.backupMeta), originalMeta);
    writeFileSync(plan.path, "interrupted markdown");
    writeFileSync(join(dir, "plan.json"), "interrupted metadata");
    writeFileSync(join(dir, ".plan-transaction.json"), JSON.stringify(transaction));

    const originalUnlink = fs.unlinkSync;
    const unlink = vi.spyOn(fs, "unlinkSync");
    unlink.mockImplementation(((path: fs.PathLike) => {
      if (String(path) === join(dir, transaction[failedArtifact])) {
        throw new Error("injected artifact cleanup failure");
      }
      return originalUnlink(path);
    }) as typeof fs.unlinkSync);
    try {
      expect(() => readPlanById(root, plan.id)).toThrow("injected artifact cleanup failure");
    } finally {
      unlink.mockRestore();
    }

    expect(existsSync(join(dir, ".plan-transaction.json"))).toBe(false);
    expect(readFileSync(plan.path)).toEqual(originalMarkdown);
    expect(readFileSync(join(dir, "plan.json"))).toEqual(originalMeta);
    expect(readPlanById(root, plan.id)?.content).toBe(plan.content);
  });

  it.each([
    "backupMarkdown",
    "backupMeta",
    "stagedMarkdown",
    "stagedMeta",
  ] as const)("keeps committed state idempotent if cleanup fails removing %s", (failedArtifact) => {
    const plan = write();
    const current = readPlanById(root, plan.id);
    if (!current) throw new Error("Expected the plan to be readable before promotion.");
    promotePlanRevision(root, {
      planId: plan.id,
      expectedFingerprint: fingerprintPlanSource(current),
      revision,
    });
    const dir = join(root, plan.id);
    const revisionMarkdown = readFileSync(plan.path);
    const revisionMeta = readFileSync(join(dir, "plan.json"));
    const suffix = "123e4567-e89b-12d3-a456-426614174000";
    const transaction = {
      state: "committed",
      backupMarkdown: `.plan.md.${suffix}.backup`,
      backupMeta: `.plan.json.${suffix}.backup`,
      stagedMarkdown: `.plan.md.${suffix}.stage`,
      stagedMeta: `.plan.json.${suffix}.stage`,
    };
    for (const key of ["backupMarkdown", "backupMeta", "stagedMarkdown", "stagedMeta"] as const) {
      writeFileSync(join(dir, transaction[key]), "transaction artifact");
    }
    writeFileSync(join(dir, ".plan-transaction.json"), JSON.stringify(transaction));

    const originalUnlink = fs.unlinkSync;
    const unlink = vi.spyOn(fs, "unlinkSync");
    unlink.mockImplementation(((path: fs.PathLike) => {
      if (String(path) === join(dir, transaction[failedArtifact])) {
        throw new Error("injected artifact cleanup failure");
      }
      return originalUnlink(path);
    }) as typeof fs.unlinkSync);
    try {
      expect(() => readPlanById(root, plan.id)).toThrow("injected artifact cleanup failure");
    } finally {
      unlink.mockRestore();
    }

    expect(existsSync(join(dir, ".plan-transaction.json"))).toBe(false);
    expect(readFileSync(plan.path)).toEqual(revisionMarkdown);
    expect(readFileSync(join(dir, "plan.json"))).toEqual(revisionMeta);
    expect(readPlanById(root, plan.id)?.title).toBe(revision.title);
  });

  it.each([
    "{truncated",
    JSON.stringify({
      backupMarkdown: "../../outside",
      backupMeta: "plan.json.backup",
      stagedMarkdown: "plan.md.stage",
      stagedMeta: "plan.json.stage",
    }),
  ])("preserves files and refuses malformed or unsafe recovery markers", (marker) => {
    const plan = write();
    const dir = join(root, plan.id);
    const originalMarkdown = readFileSync(plan.path);
    const originalMeta = readFileSync(join(dir, "plan.json"));
    writeFileSync(join(dir, ".plan-transaction.json"), marker);

    expect(() => readPlanById(root, plan.id)).toThrow(/transaction/i);
    expect(readFileSync(plan.path)).toEqual(originalMarkdown);
    expect(readFileSync(join(dir, "plan.json"))).toEqual(originalMeta);
    expect(existsSync(join(dir, ".plan-transaction.json"))).toBe(true);
  });

  it("rejects symlinked transaction artifacts without modifying the external target", () => {
    const plan = write();
    const dir = join(root, plan.id);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "external bytes");
    const link = join(dir, ".plan.md.123e4567-e89b-12d3-a456-426614174000.backup");
    const originalLstat = fs.lstatSync;
    const lstat = vi.spyOn(fs, "lstatSync");
    lstat.mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === link) {
        return { isSymbolicLink: () => true, isFile: () => false } as fs.Stats;
      }
      return (originalLstat as (...args: unknown[]) => fs.Stats)(path, ...args);
    }) as typeof fs.lstatSync);
    writeFileSync(
      join(dir, ".plan-transaction.json"),
      JSON.stringify({
        state: "prepared",
        backupMarkdown: ".plan.md.123e4567-e89b-12d3-a456-426614174000.backup",
        backupMeta: ".plan.json.123e4567-e89b-12d3-a456-426614174000.backup",
        stagedMarkdown: ".plan.md.123e4567-e89b-12d3-a456-426614174000.stage",
        stagedMeta: ".plan.json.123e4567-e89b-12d3-a456-426614174000.stage",
      }),
    );

    try {
      expect(() => readPlanById(root, plan.id)).toThrow(/symlink/i);
      expect(readFileSync(outside, "utf8")).toBe("external bytes");
      expect(existsSync(join(dir, ".plan-transaction.json"))).toBe(true);
    } finally {
      lstat.mockRestore();
    }
  });

  it("rejects a symlinked plan directory without touching its external files", () => {
    const plan = write();
    const planPath = join(root, plan.id);
    const externalDir = join(root, "external-plan");
    mkdirSync(externalDir);
    const externalMarker = join(externalDir, ".plan-transaction.json");
    writeFileSync(externalMarker, "external marker bytes");
    writeFileSync(join(externalDir, "plan.md"), "external plan bytes");
    writeFileSync(
      join(externalDir, "plan.json"),
      JSON.stringify({ ...plan, path: join(externalDir, "plan.md") }),
    );
    const originalLstat = fs.lstatSync;
    let realSymlinkSupported = true;
    try {
      rmSync(planPath, { recursive: true, force: true });
      fs.symlinkSync(externalDir, planPath, "junction");
    } catch {
      realSymlinkSupported = false;
      // Fallback exercises the same directory-component rejection where Windows policy or
      // runner permissions prevent creating a real directory symlink/junction.
      const lstat = vi.spyOn(fs, "lstatSync");
      lstat.mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
        if (String(path) === planPath) {
          return { isSymbolicLink: () => true, isDirectory: () => false } as fs.Stats;
        }
        return (originalLstat as (...statArgs: unknown[]) => fs.Stats)(path, ...args);
      }) as typeof fs.lstatSync);
      const originalExists = fs.existsSync;
      const exists = vi.spyOn(fs, "existsSync");
      exists.mockImplementation((path: fs.PathLike) =>
        String(path) === join(planPath, "plan.json") ? true : originalExists(path),
      );
      try {
        expect(() => readPlanById(root, plan.id)).toThrow(/symlink/i);
      } finally {
        exists.mockRestore();
        lstat.mockRestore();
      }
    }

    if (realSymlinkSupported) {
      expect(() => readPlanById(root, plan.id)).toThrow(/symlink/i);
    }
    expect(readFileSync(externalMarker, "utf8")).toBe("external marker bytes");
  });

  it("rejects a traversal marker without touching the external file it names", () => {
    const plan = write();
    const external = join(tmpdir(), `${basename(root)}-outside.txt`);
    writeFileSync(external, "external bytes");
    writeFileSync(
      join(root, plan.id, ".plan-transaction.json"),
      JSON.stringify({
        state: "prepared",
        backupMarkdown: `../../${basename(external)}`,
        backupMeta: ".plan.json.123e4567-e89b-12d3-a456-426614174000.backup",
        stagedMarkdown: ".plan.md.123e4567-e89b-12d3-a456-426614174000.stage",
        stagedMeta: ".plan.json.123e4567-e89b-12d3-a456-426614174000.stage",
      }),
    );

    try {
      expect(() => readPlanById(root, plan.id)).toThrow(/artifact names/i);
      expect(readFileSync(external, "utf8")).toBe("external bytes");
    } finally {
      rmSync(external, { force: true });
    }
  });

  it.each([
    1, 2, 3,
  ])("keeps a committed revision successful when cleanup unlink %i fails", (failAt) => {
    const plan = write();
    const current = readPlanById(root, plan.id);
    if (!current) throw new Error("Expected the plan to be readable before promotion.");
    const originalUnlink = fs.unlinkSync;
    let calls = 0;
    const remove = vi.spyOn(fs, "unlinkSync");
    remove.mockImplementation(((...args: Parameters<typeof fs.unlinkSync>) => {
      calls += 1;
      if (calls === failAt) throw new Error("injected cleanup failure");
      return originalUnlink(...args);
    }) as typeof fs.unlinkSync);
    let promoted: ReturnType<typeof promotePlanRevision> | undefined;
    try {
      promoted = promotePlanRevision(root, {
        planId: plan.id,
        expectedFingerprint: fingerprintPlanSource(current),
        revision,
      });
    } finally {
      remove.mockRestore();
    }

    expect(promoted?.title).toBe(revision.title);
    expect(calls).toBeGreaterThanOrEqual(failAt);
    expect(readPlanById(root, plan.id)?.title).toBe(revision.title);
  });
});
