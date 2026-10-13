import { describe, expect, it, vi } from "vitest";
import type { PlanRef } from "../../../../shared/contracts";
import { canSubmitChatComposer, createPlanBuildOperations, planSourceProjection } from "./ChatPane";

const plan: PlanRef = {
  id: "plan-1",
  title: "Release readiness",
  overview: "Prepare the release safely.",
  path: "/workspace/plan.md",
  hash: "hash-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  blocks: [{ type: "markdown", content: "# Release" }],
  content: "# Release",
  todos: [{ id: "todo-1", content: "Run release checks", status: "pending" }],
  spec: {
    requirements: [{ id: "req-1", text: "Release safely" }],
    acceptanceCriteria: [
      {
        id: "criterion-1",
        requirementId: "req-1",
        description: "All release checks pass",
        todoIds: ["todo-1"],
        requiredCheckKinds: ["tests"],
        status: "pending",
      },
    ],
    evidence: [],
    assumptions: [],
    openQuestions: [],
  },
  buildStatus: "not_built",
  createdAt: "now",
  updatedAt: "now",
};

describe("plan approval", () => {
  it("keeps the exact plan source across a failed start and a retry", async () => {
    const startPlanBuild = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValue({ runId: "r" });
    const operations = createPlanBuildOperations({ startPlanBuild }, () => "stable-request");
    await expect(operations.start(plan)).rejects.toThrow("transport failed");
    await operations.start(plan);
    expect(startPlanBuild.mock.calls.map(([input]) => input)).toEqual([
      {
        sessionId: plan.sessionId,
        planId: plan.id,
        sourceSnapshot: planSourceProjection(plan),
        requestId: "stable-request",
      },
      {
        sessionId: plan.sessionId,
        planId: plan.id,
        sourceSnapshot: planSourceProjection(plan),
        requestId: "stable-request",
      },
    ]);
  });
  it("shares an in-flight approval instead of reporting a premature second success", async () => {
    let release!: () => void;
    let secondSettled = false;
    const api = {
      startPlanBuild: () =>
        new Promise<never>((resolve) => {
          release = () => resolve({} as never);
        }),
    };
    const operations = createPlanBuildOperations(api, () => "one-request");
    const first = operations.start(plan);
    const second = operations.start(plan).then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    const premature = secondSettled;
    release();
    await Promise.all([first, second]);
    expect(premature).toBe(false);
  });
  it("allows a revised source to start with a new approval identity", async () => {
    const requests: unknown[] = [];
    const operations = createPlanBuildOperations(
      {
        startPlanBuild: async (
          input: Parameters<Window["modus"]["agent"]["startPlanBuild"]>[0],
        ) => {
          requests.push(input);
          return { sessionId: plan.sessionId, planId: plan.id, planFingerprint: "fp", runId: "r" };
        },
      },
      (() => {
        let id = 0;
        return () => String(++id);
      })(),
    );
    await operations.start(plan);
    await operations.start(plan);
    await operations.start({ ...plan, content: "Revised implementation" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      requestId: "2",
      sourceSnapshot: { content: "Revised implementation" },
    });
  });
});
describe("canSubmitChatComposer", () => {
  const base = {
    branchBlocked: false,
    modelBlocked: false,
    workspace: null,
    sessionWorkspaceId: "modus-inbox-chats",
    modelId: "openai/gpt-5",
  };
  it("allows send with a usable model and branch", () => {
    expect(canSubmitChatComposer(base)).toBe(true);
  });
  it("blocks send while the saved model is unusable", () => {
    expect(canSubmitChatComposer({ ...base, modelBlocked: true })).toBe(false);
  });
  it("blocks send while the saved branch is missing", () => {
    expect(canSubmitChatComposer({ ...base, branchBlocked: true })).toBe(false);
  });
});
