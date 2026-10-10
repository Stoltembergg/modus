import { describe, expect, it } from "vitest";
import {
  agentApplyHyperPlanRevisionSchema,
  agentEventPageRequestSchema,
  agentPromptSchema,
  agentSetBranchSchema,
  agentStartOriginalPlanBuildSchema,
  browserRecentSchema,
  diffCommitOrPushSchema,
  limitsCodexEnabledSchema,
  mcpUpsertSchema,
  parseIpcInput,
  permissionDecideSchema,
  providerAuthStartSchema,
} from "./schemas";

describe("IPC schemas", () => {
  it("accepts bounded event history pages and rejects ambiguous or oversized cursors", () => {
    expect(
      agentEventPageRequestSchema.safeParse({
        sessionId: "session-1",
        options: { direction: "backward", snapshotCursor: 100, limit: 128 },
      }).success,
    ).toBe(true);
    expect(
      agentEventPageRequestSchema.safeParse({
        sessionId: "session-1",
        options: { direction: "backward", beforeCursor: 100, snapshotCursor: 100, limit: 256 },
      }).success,
    ).toBe(true);
    expect(
      agentEventPageRequestSchema.safeParse({
        sessionId: "session-1",
        options: { direction: "backward", afterCursor: 4 },
      }).success,
    ).toBe(false);
    expect(
      agentEventPageRequestSchema.safeParse({
        sessionId: "session-1",
        options: { direction: "forward", beforeCursor: 4 },
      }).success,
    ).toBe(false);
    expect(
      agentEventPageRequestSchema.safeParse({
        sessionId: "session-1",
        options: { direction: "forward", runId: "run-1", afterCursor: 0, limit: 64 },
      }).success,
    ).toBe(true);
    expect(
      agentEventPageRequestSchema.safeParse({
        sessionId: "session-1",
        options: { direction: "backward", limit: 257 },
      }).success,
    ).toBe(false);
  });

  it("requires a bounded strict source snapshot for original-plan builds", () => {
    const snapshot = {
      title: "Plan",
      overview: "Overview",
      content: "# Plan",
      todos: [{ id: "todo-1", content: "Task", acceptanceCriterionIds: ["criterion-1"] }],
      spec: {
        requirements: [{ id: "req-1", text: "Requirement" }],
        acceptanceCriteria: [
          {
            id: "criterion-1",
            requirementId: "req-1",
            description: "Pass",
            todoIds: ["todo-1"],
            status: "pending",
          },
        ],
        assumptions: [],
        openQuestions: [],
        evidence: [],
      },
    };
    const input = {
      sessionId: "session-1",
      planId: "plan-1",
      requestId: "request-1",
      sourceSnapshot: snapshot,
    };
    expect(
      parseIpcInput(agentStartOriginalPlanBuildSchema, input, "agent:start-original-plan-build"),
    ).toEqual(input);
    expect(() =>
      parseIpcInput(
        agentStartOriginalPlanBuildSchema,
        { ...input, sourceSnapshot: { ...snapshot, content: "x".repeat(64 * 1024 + 1) } },
        "agent:start-original-plan-build",
      ),
    ).toThrow("Invalid IPC payload");
    expect(() =>
      parseIpcInput(
        agentStartOriginalPlanBuildSchema,
        {
          ...input,
          sourceSnapshot: {
            ...snapshot,
            todos: Array.from({ length: 101 }, (_, i) => ({
              id: String(i),
              content: "Task",
              acceptanceCriterionIds: [] as string[],
            })),
          },
        },
        "agent:start-original-plan-build",
      ),
    ).toThrow("Invalid IPC payload");
  });

  it("round-trips original-plan source strings and stable IDs without normalization", () => {
    const input = {
      sessionId: "session-1",
      planId: "plan-1",
      requestId: "request-1",
      sourceSnapshot: {
        title: "T".repeat(201),
        overview: "O".repeat(12 * 1024 + 1),
        content: "# Plan",
        todos: [
          {
            id: " todo-1 ",
            content: "C".repeat(12 * 1024 + 1),
            acceptanceCriterionIds: [" criterion-1 "],
          },
        ],
        spec: {
          requirements: [{ id: " req-1 ", text: "Requirement" }],
          acceptanceCriteria: [
            {
              id: " criterion-1 ",
              requirementId: " req-1 ",
              description: "Pass",
              todoIds: [" todo-1 "],
              status: "pending",
            },
          ],
          assumptions: [],
          openQuestions: [],
          evidence: [
            {
              id: " evidence-1 ",
              kind: "test",
              status: "passed",
              runId: " run-1 ",
              eventId: " event-1 ",
              revision: " revision-1 ",
              paths: [],
              label: "Test",
              criterionId: " criterion-1 ",
            },
          ],
        },
      },
    };

    expect(
      parseIpcInput(agentStartOriginalPlanBuildSchema, input, "agent:start-original-plan-build"),
    ).toEqual(input);
  });

  it("rejects unsafe source snapshot sizes and whitespace-only or oversized IDs", () => {
    const input = {
      sessionId: "session-1",
      planId: "plan-1",
      requestId: "request-1",
      sourceSnapshot: {
        title: "Plan",
        overview: "Overview",
        content: "# Plan",
        todos: [{ id: "todo-1", content: "Task", acceptanceCriterionIds: ["criterion-1"] }],
        spec: {
          requirements: [{ id: "req-1", text: "Requirement" }],
          acceptanceCriteria: [
            {
              id: "criterion-1",
              requirementId: "req-1",
              description: "Pass",
              todoIds: ["todo-1"],
              status: "pending",
            },
          ],
          assumptions: [] as string[],
          openQuestions: [] as string[],
          evidence: [],
        },
      },
    };
    const reject = (sourceSnapshot: typeof input.sourceSnapshot) =>
      expect(() =>
        parseIpcInput(
          agentStartOriginalPlanBuildSchema,
          { ...input, sourceSnapshot },
          "agent:start-original-plan-build",
        ),
      ).toThrow("Invalid IPC payload");

    reject({ ...input.sourceSnapshot, title: "X".repeat(1024 * 1024) });
    reject({ ...input.sourceSnapshot, content: "" });
    reject({
      ...input.sourceSnapshot,
      todos: [{ id: " \t ", content: "Task", acceptanceCriterionIds: ["criterion-1"] }],
    });
    reject({
      ...input.sourceSnapshot,
      todos: [{ id: "x".repeat(129), content: "Task", acceptanceCriterionIds: ["criterion-1"] }],
    });
    reject({
      ...input.sourceSnapshot,
      spec: { ...input.sourceSnapshot.spec, assumptions: ["A".repeat(501)] },
    });
    reject({
      ...input.sourceSnapshot,
      spec: {
        ...input.sourceSnapshot.spec,
        openQuestions: Array.from({ length: 21 }, () => "Question"),
      },
    });
  });

  it("accepts a bounded strict HyperPlan revision payload", () => {
    const valid = {
      sessionId: "session-1",
      planId: "plan-1",
      planHash: "hash-1",
      revisedContent: "# Revised",
    };
    expect(
      parseIpcInput(agentApplyHyperPlanRevisionSchema, valid, "agent:apply-hyperplan-revision"),
    ).toEqual(valid);
    const atByteLimit = { ...valid, revisedContent: "x".repeat(12 * 1024) };
    expect(
      parseIpcInput(
        agentApplyHyperPlanRevisionSchema,
        atByteLimit,
        "agent:apply-hyperplan-revision",
      ),
    ).toEqual(atByteLimit);
    for (const input of [
      { ...valid, extra: true },
      { ...valid, revisedContent: "  " },
      { ...valid, revisedContent: "x".repeat(12 * 1024 + 1) },
      { ...valid, revisedContent: "é".repeat(8_000) },
    ]) {
      expect(() =>
        parseIpcInput(agentApplyHyperPlanRevisionSchema, input, "agent:apply-hyperplan-revision"),
      ).toThrow("Invalid IPC payload");
    }
  });

  const mcpInput = {
    cwd: "repo",
    name: "server",
    transport: "stdio",
    command: "run",
    enabled: true,
  };

  it("requires acknowledgement only for Antigravity sign-in", () => {
    expect(() =>
      parseIpcInput(
        providerAuthStartSchema,
        { provider: "antigravity" },
        "model:provider-auth-start",
      ),
    ).toThrow("Invalid IPC payload");
    expect(() =>
      parseIpcInput(
        providerAuthStartSchema,
        { provider: "antigravity", riskAcknowledged: false },
        "model:provider-auth-start",
      ),
    ).toThrow("Invalid IPC payload");
    expect(
      parseIpcInput(
        providerAuthStartSchema,
        { provider: "antigravity", riskAcknowledged: true },
        "model:provider-auth-start",
      ),
    ).toEqual({ provider: "antigravity", riskAcknowledged: true });
    expect(
      parseIpcInput(providerAuthStartSchema, { provider: "openai" }, "model:provider-auth-start"),
    ).toEqual({ provider: "openai" });
  });

  it("accepts exact MCP allowlist tool names without trimming them", () => {
    expect(
      parseIpcInput(
        mcpUpsertSchema,
        {
          ...mcpInput,
          readOnlyToolAllowlist: [" exact name ", "mcp_search"],
        },
        "mcp:upsert",
      ).readOnlyToolAllowlist,
    ).toEqual([" exact name ", "mcp_search"]);
  });

  it("rejects empty, oversize, and duplicate MCP allowlist names", () => {
    for (const names of [
      ["  "],
      ["x".repeat(257)],
      Array.from({ length: 101 }, (_, i) => `tool${i}`),
      ["same", "same"],
    ]) {
      expect(() =>
        parseIpcInput(
          mcpUpsertSchema,
          {
            ...mcpInput,
            readOnlyToolAllowlist: names,
          },
          "mcp:upsert",
        ),
      ).toThrow("Invalid IPC payload");
    }
  });

  it("accepts a commit-and-push payload", () => {
    expect(
      parseIpcInput(
        diffCommitOrPushSchema,
        { cwd: "repo", message: "commit", commit: true, push: true },
        "diff:commit-or-push",
      ),
    ).toEqual({ cwd: "repo", message: "commit", commit: true, push: true });
  });

  it("accepts a push-only payload (no message)", () => {
    expect(
      parseIpcInput(
        diffCommitOrPushSchema,
        { cwd: "repo", commit: false, push: true },
        "diff:commit-or-push",
      ),
    ).toEqual({ cwd: "repo", commit: false, push: true });
  });

  it("rejects committing without a message", () => {
    expect(() =>
      parseIpcInput(
        diffCommitOrPushSchema,
        { cwd: "repo", message: "", commit: true, push: false },
        "diff:commit-or-push",
      ),
    ).toThrow("Invalid IPC payload");
  });

  it("rejects a no-op (neither commit nor push)", () => {
    expect(() =>
      parseIpcInput(
        diffCommitOrPushSchema,
        { cwd: "repo", commit: false, push: false },
        "diff:commit-or-push",
      ),
    ).toThrow("Invalid IPC payload");
  });

  it("validates permission decisions", () => {
    expect(
      parseIpcInput(
        permissionDecideSchema,
        {
          requestId: "request-1",
          action: "git.write",
          target: "git clean -f",
          decision: "deny",
        },
        "permission:decide",
      ),
    ).toEqual({
      requestId: "request-1",
      action: "git.write",
      target: "git clean -f",
      decision: "deny",
    });
    expect(() =>
      parseIpcInput(
        permissionDecideSchema,
        { action: "git.write", target: "git clean -f", decision: "deny" },
        "permission:decide",
      ),
    ).toThrow("Invalid IPC payload");
  });

  // Regression: a prompt turn must carry its own execution params (mode, model,
  // thinking) across the IPC boundary. Dropping any of these here was the
  // root of the "stale model / thinking / plan-mode on resend" bugs.
  it("preserves per-turn execution params (mode, model, thinking)", () => {
    const parsed = parseIpcInput(
      agentPromptSchema,
      {
        sessionId: "s1",
        message: "hi",
        mode: "plan",
        model: "openai/gpt-5.5",
        thinkingLevel: "xhigh",
        thinkingVariant: "max",
      },
      "agent:prompt",
    );
    expect(parsed.mode).toBe("plan");
    expect(parsed.model).toBe("openai/gpt-5.5");
    expect(parsed.thinkingLevel).toBe("xhigh");
    expect(parsed.thinkingVariant).toBe("max");
  });

  it("validates browser recent deletion payloads", () => {
    expect(parseIpcInput(browserRecentSchema, { id: "recent-1" }, "browser:delete-recent")).toEqual(
      { id: "recent-1" },
    );
    expect(() => parseIpcInput(browserRecentSchema, { id: "" }, "browser:delete-recent")).toThrow(
      "Invalid IPC payload",
    );
  });

  it("accepts only the explicit Codex limits boolean and rejects extra inputs", () => {
    expect(
      parseIpcInput(limitsCodexEnabledSchema, { enabled: true }, "model:limits-set-codex-enabled"),
    ).toEqual({ enabled: true });
    expect(() =>
      parseIpcInput(
        limitsCodexEnabledSchema,
        { enabled: "true" },
        "model:limits-set-codex-enabled",
      ),
    ).toThrow("Invalid IPC payload");
    expect(() =>
      parseIpcInput(
        limitsCodexEnabledSchema,
        { enabled: true, provider: "x" },
        "model:limits-set-codex-enabled",
      ),
    ).toThrow("Invalid IPC payload");
  });

  it("leaves per-turn params undefined when omitted (keeps session defaults)", () => {
    const parsed = parseIpcInput(
      agentPromptSchema,
      { sessionId: "s1", message: "hi" },
      "agent:prompt",
    );
    expect(parsed.mode).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.thinkingLevel).toBeUndefined();
    expect(parsed.thinkingVariant).toBeUndefined();
  });

  it("rejects an invalid thinkingLevel", () => {
    expect(() =>
      parseIpcInput(
        agentPromptSchema,
        { sessionId: "s1", message: "hi", thinkingLevel: "ultra" },
        "agent:prompt",
      ),
    ).toThrow("Invalid IPC payload");
  });

  it("L2 agent:set-branch takes only a session id and a branch NAME (never a path)", () => {
    expect(
      parseIpcInput(
        agentSetBranchSchema,
        { sessionId: "s1", branch: "feat/l2" },
        "agent:set-branch",
      ),
    ).toEqual({ sessionId: "s1", branch: "feat/l2" });
    for (const branch of ["/etc/passwd", "../x", "a..b", "-f", "x y", "feat/", "a.lock", ""]) {
      expect(() =>
        parseIpcInput(agentSetBranchSchema, { sessionId: "s1", branch }, "agent:set-branch"),
      ).toThrow("Invalid IPC payload");
    }
    expect(() =>
      parseIpcInput(
        agentSetBranchSchema,
        { sessionId: "s1", branch: "main", cwd: "/elsewhere" },
        "agent:set-branch",
      ),
    ).toThrow("Invalid IPC payload");
  });
});

it("validates capabilities on every agent and group creation path", async () => {
  const schemas = await import("./schemas");
  const split = await import("./schemas-part-04");
  for (const source of [schemas, split]) {
    const metadata = { capabilityIds: ["review", "review"], supportedTaskKinds: ["code", "code"] };
    const member = { name: "Custom", modelId: "m-1", ...metadata };
    expect(source.agentsCreateSchema.parse({ ...member, groupId: "g-1" })).toMatchObject({
      capabilityIds: ["review"],
      supportedTaskKinds: ["code"],
    });
    expect(source.agentsUpdateSchema.parse({ id: "a-1", ...metadata })).toMatchObject({
      capabilityIds: ["review"],
      supportedTaskKinds: ["code"],
    });
    expect(
      source.groupCreateSchema.parse({ name: "Group", workspaceId: "w-1", members: [member] })
        .members[0],
    ).toMatchObject({ capabilityIds: ["review"], supportedTaskKinds: ["code"] });
    for (const invalid of [
      { capabilityIds: ["shell"] },
      { supportedTaskKinds: ["implement"] },
      { capabilityIds: "review" },
      { capabilityIds: null },
      { supportedTaskKinds: null },
      { tools: ["shell"] },
    ]) {
      expect(
        source.agentsCreateSchema.safeParse({ groupId: "g-1", name: "Custom", ...invalid }).success,
      ).toBe(false);
      expect(source.agentsUpdateSchema.safeParse({ id: "a-1", ...invalid }).success).toBe(false);
      expect(
        source.groupCreateSchema.safeParse({
          name: "Group",
          workspaceId: "w-1",
          members: [{ name: "Custom", ...invalid }],
        }).success,
      ).toBe(false);
    }
  }
});
