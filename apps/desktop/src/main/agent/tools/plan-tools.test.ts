import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../shared/contracts";
import { PLAN_TOOL_NAME } from "../../../shared/tools";
import { readPlan } from "../../plan/plan-store";
import { registerPlanTools } from "./plan-tools";
import { toolRegistry } from "./registry";
import { type AgentToolContext, runWithAgentToolContext } from "./tool-context";

const testState = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => testState.userData,
  },
}));

beforeEach(async () => {
  testState.userData = await mkdtemp(join(tmpdir(), "modus-plan-tool-test-"));
  registerPlanTools();
});

afterEach(async () => {
  await rm(testState.userData, { recursive: true, force: true }).catch(() => undefined);
});

function planTool() {
  const tool = toolRegistry
    .getCustomToolDefinitions("plan")
    .find((definition) => definition.name === PLAN_TOOL_NAME);
  if (!tool?.execute) {
    throw new Error("plan_write tool not registered");
  }
  return tool;
}

describe("plan_write", () => {
  const specInput = {
    requirements: [{ id: "req-auth", text: "Protect authenticated routes." }],
    acceptanceCriteria: [
      {
        id: "ac-auth",
        requirementId: "req-auth",
        description: "Unauthenticated requests are rejected.",
        todoIds: ["todo-guard"],
        requiredCheckKinds: ["tests", "typecheck"],
      },
    ],
    assumptions: ["Existing session middleware remains authoritative."],
    openQuestions: ["Should expired tokens use a distinct response code?"],
  };

  it("writes plan.md from markdown content and persists string todos as PlanTodo items", async () => {
    const cwd = "plan-cwd";
    const events: AgentEvent[] = [];
    const context: AgentToolContext = {
      workspaceId: "workspace",
      cwd,
      sessionId: "session",
      profile: "plan",
      emit: (event) => events.push(event),
    };

    const result = await runWithAgentToolContext(context, async () =>
      planTool().execute(
        "plan-call",
        {
          title: "Plan Tool",
          overview: "Use constrained write semantics.",
          todos: ["Update the schema", "Reuse the diff card"],
          content: '# Plan Tool\n\n```ts\nconst path = "C:\\\\Users\\\\ASUS";\n```\n',
        },
        new AbortController().signal,
        undefined,
        { cwd } as Parameters<ReturnType<typeof planTool>["execute"]>[4],
      ),
    );

    expect(result.content[0]?.type).toBe("text");
    const plan = readPlan(join(testState.userData, "plans"), "session");
    expect(await readFile(plan?.path ?? "", "utf8")).toContain(
      'const path = "C:\\\\Users\\\\ASUS"',
    );
    expect(plan?.todos.map((todo) => todo.content)).toEqual([
      "Update the schema",
      "Reuse the diff card",
    ]);
    expect(plan?.blocks).toEqual([
      {
        type: "markdown",
        content: '# Plan Tool\n\n```ts\nconst path = "C:\\\\Users\\\\ASUS";\n```',
      },
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "plan.updated",
        sessionId: "session",
        toolCallId: "plan-call",
        plan: expect.objectContaining({ title: "Plan Tool" }),
      }),
    ]);
  });

  it("keeps the tool schema strict so malformed extra fields do not validate", () => {
    const schema = planTool().parameters;
    const valid = {
      title: "Plan Tool",
      overview: "Use constrained write semantics.",
      todos: ["Update the schema"],
      content: "# Plan\n",
    };
    expect(Value.Check(schema, valid)).toBe(true);
    expect(Value.Check(schema, { ...valid, unexpected: "extra data" })).toBe(false);
    expect(
      Value.Check(schema, {
        ...valid,
        blocks: [{ type: "markdown", content: "# Plan\n" }],
      }),
    ).toBe(false);
  });

  it("rejects oversized plan content by character and UTF-8 byte limits", async () => {
    const schema = planTool().parameters;
    const base = {
      title: "Plan Tool",
      overview: "Use constrained write semantics.",
      todos: ["Update the schema"],
      content: "# Plan\n",
    };
    expect(Value.Check(schema, { ...base, content: "x".repeat(65_537) })).toBe(false);

    const cwd = "oversized-plan-cwd";
    const context: AgentToolContext = {
      workspaceId: "workspace",
      cwd,
      sessionId: "oversized-plan-session",
      profile: "plan",
    };
    const multibyteParams = { ...base, content: "é".repeat(32_769) };
    expect(Value.Check(schema, multibyteParams)).toBe(true);
    await expect(
      runWithAgentToolContext(context, () =>
        planTool().execute(
          "oversized-plan-call",
          multibyteParams,
          new AbortController().signal,
          undefined,
          { cwd } as Parameters<ReturnType<typeof planTool>["execute"]>[4],
        ),
      ),
    ).rejects.toThrow("Plan content exceeds the maximum allowed size.");
    expect(readPlan(join(testState.userData, "plans"), context.sessionId)).toBeUndefined();
  });

  it("accepts and persists structured spec metadata only in Spec Mode", async () => {
    const cwd = "spec-cwd";
    const events: AgentEvent[] = [];
    const context: AgentToolContext = {
      workspaceId: "workspace",
      cwd,
      sessionId: "spec-session",
      profile: "plan",
      mode: "spec",
      emit: (event) => events.push(event),
    };
    const params = {
      title: "Spec Tool",
      overview: "Create an evidence-oriented implementation plan.",
      todos: [
        {
          id: "todo-guard",
          content: "Add the route guard",
          acceptanceCriterionIds: ["ac-auth"],
        },
      ],
      content: "# Spec Tool\n\nPreserve the Markdown plan.",
      spec: specInput,
    };

    expect(Value.Check(planTool().parameters, params)).toBe(true);
    const result = await runWithAgentToolContext(context, () =>
      planTool().execute("spec-call", params, new AbortController().signal, undefined, {
        cwd,
      } as Parameters<ReturnType<typeof planTool>["execute"]>[4]),
    );

    const plan = readPlan(join(testState.userData, "plans"), "spec-session");
    expect(plan?.spec).toEqual({
      ...specInput,
      acceptanceCriteria: [{ ...specInput.acceptanceCriteria[0], status: "pending" }],
      evidence: [],
    });
    expect(plan?.todos).toEqual([
      {
        id: "todo-guard",
        content: "Add the route guard",
        acceptanceCriterionIds: ["ac-auth"],
        status: "pending",
      },
    ]);
    expect(plan?.content).toBe("# Spec Tool\n\nPreserve the Markdown plan.");
    expect(result.details).toMatchObject({ spec: plan?.spec });
    expect(events).toEqual([expect.objectContaining({ type: "plan.updated", plan })]);
  });

  it("rejects spec metadata in ordinary Plan Mode", async () => {
    const cwd = "plan-cwd";
    const context: AgentToolContext = {
      workspaceId: "workspace",
      cwd,
      sessionId: "plan-session",
      profile: "plan",
      mode: "plan",
    };
    const params = {
      title: "Plan Tool",
      overview: "Ordinary plans stay unstructured.",
      todos: ["Implement the route guard"],
      content: "# Plan\n",
      spec: specInput,
    };

    expect(Value.Check(planTool().parameters, params)).toBe(true);
    await expect(
      runWithAgentToolContext(context, () =>
        planTool().execute("plan-call", params, new AbortController().signal, undefined, {
          cwd,
        } as Parameters<ReturnType<typeof planTool>["execute"]>[4]),
      ),
    ).rejects.toThrow("Structured plan metadata is available only in Spec Mode.");
    expect(readPlan(join(testState.userData, "plans"), "plan-session")).toBeUndefined();
  });

  it("rejects structured todo metadata in ordinary Plan Mode", async () => {
    const cwd = "plan-cwd";
    const context: AgentToolContext = {
      workspaceId: "workspace",
      cwd,
      sessionId: "plan-structured-todos",
      profile: "plan",
      mode: "plan",
    };
    const params = {
      title: "Plan Tool",
      overview: "Ordinary plans stay unstructured.",
      todos: [{ id: "todo-1", content: "Implement the route guard" }],
      content: "# Plan\n",
    };

    await expect(
      runWithAgentToolContext(context, () =>
        planTool().execute("plan-call", params, new AbortController().signal, undefined, {
          cwd,
        } as Parameters<ReturnType<typeof planTool>["execute"]>[4]),
      ),
    ).rejects.toThrow("Structured plan metadata is available only in Spec Mode.");
    expect(readPlan(join(testState.userData, "plans"), "plan-structured-todos")).toBeUndefined();
  });

  it("rejects unsupported check kinds, claimed criterion completion, and extra spec fields", () => {
    const valid = {
      title: "Spec Tool",
      overview: "Create an evidence-oriented implementation plan.",
      todos: [
        { id: "todo-guard", content: "Add the route guard", acceptanceCriterionIds: ["ac-auth"] },
      ],
      content: "# Spec Tool",
      spec: specInput,
    };
    const schema = planTool().parameters;

    expect(Value.Check(schema, valid)).toBe(true);
    expect(
      Value.Check(schema, {
        ...valid,
        spec: {
          ...specInput,
          acceptanceCriteria: [{ ...specInput.acceptanceCriteria[0], status: "passed" }],
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(schema, {
        ...valid,
        spec: {
          ...specInput,
          acceptanceCriteria: [
            { ...specInput.acceptanceCriteria[0], requiredCheckKinds: ["security"] },
          ],
        },
      }),
    ).toBe(false);
    expect(Value.Check(schema, { ...valid, spec: { ...specInput, private: "extra" } })).toBe(false);
  });

  it.each([
    "passed",
    "user_confirmed",
  ] as const)("rejects model-authored %s evidence as authoritative Plan metadata", async (status) => {
    const cwd = "spec-cwd";
    const context: AgentToolContext = {
      workspaceId: "workspace",
      cwd,
      sessionId: `model-evidence-${status}`,
      profile: "plan",
      mode: "spec",
    };
    const params = {
      title: "Spec Tool",
      overview: "Model evidence must not be authoritative.",
      todos: [
        {
          id: "todo-guard",
          content: "Add the route guard",
          acceptanceCriterionIds: ["ac-auth"],
        },
      ],
      content: "# Spec Tool",
      spec: {
        ...specInput,
        evidence: [
          {
            id: `claimed-${status}`,
            criterionId: "ac-auth",
            kind: "check",
            status,
            label: "Tests",
          },
        ],
      },
    };

    expect(Value.Check(planTool().parameters, params)).toBe(false);
    await expect(
      runWithAgentToolContext(context, () =>
        planTool().execute("model-evidence-call", params, new AbortController().signal, undefined, {
          cwd,
        } as Parameters<ReturnType<typeof planTool>["execute"]>[4]),
      ),
    ).rejects.toThrow("Invalid plan_write parameters.");
    expect(readPlan(join(testState.userData, "plans"), context.sessionId)).toBeUndefined();
  });

  it("enforces the strict schema again when the tool is invoked directly", async () => {
    const cwd = "spec-cwd";
    const context: AgentToolContext = {
      workspaceId: "workspace",
      cwd,
      sessionId: "invalid-spec-session",
      profile: "plan",
      mode: "spec",
    };
    const invalidParams = {
      title: "Spec Tool",
      overview: "Create a plan.",
      todos: ["Implement the behavior"],
      content: "# Spec Tool",
      spec: { ...specInput, undeclared: "must fail closed" },
    };

    await expect(
      runWithAgentToolContext(context, () =>
        planTool().execute(
          "invalid-spec-call",
          invalidParams,
          new AbortController().signal,
          undefined,
          { cwd } as Parameters<ReturnType<typeof planTool>["execute"]>[4],
        ),
      ),
    ).rejects.toThrow("Invalid plan_write parameters.");
    expect(readPlan(join(testState.userData, "plans"), "invalid-spec-session")).toBeUndefined();
  });

  it("rejects plans without a workspace/session context", async () => {
    const context: AgentToolContext = {
      workspaceId: "",
      cwd: "plan-cwd",
      sessionId: "",
      profile: "plan",
    };
    await expect(
      runWithAgentToolContext(context, () =>
        planTool().execute(
          "plan-call",
          {
            title: "Plan Tool",
            overview: "Use constrained write semantics.",
            todos: ["Update the schema"],
            content: "# Plan\n",
          },
          new AbortController().signal,
          undefined,
          { cwd: "plan-cwd" } as Parameters<ReturnType<typeof planTool>["execute"]>[4],
        ),
      ),
    ).rejects.toThrow("No active Modus workspace for this plan.");
  });
});
