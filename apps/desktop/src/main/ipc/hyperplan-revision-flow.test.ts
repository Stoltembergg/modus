import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end HyperPlan revision flow: the real harness parses the model output, the real
 * draft store holds the preview, and choosing "revision" promotes it through the real plan
 * store on disk. Only the model session, Electron, and session lookup are faked.
 */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  root: "",
  revisionOutput: "",
  publishPlanUpdated: vi.fn(),
  sessionOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getVersion: () => "test" },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, webContents: {} }) },
}));
vi.mock("../agent/agent-store", () => ({
  getAgentSession: (id: string) =>
    id === "session-1" ? { id: "session-1", workspaceId: "ws-1" } : undefined,
}));
vi.mock("../agent/agent-event-store", () => ({ recordAgentEvent: vi.fn() }));
vi.mock("../agent/tools/plan-tools", () => ({ plansRoot: () => mocks.root }));
vi.mock("../agent/runtime-registry", () => ({
  getAgentRuntime: () => ({
    assertHyperPlanSessionAvailable: vi.fn(),
    publishPlanUpdated: mocks.publishPlanUpdated,
  }),
}));
vi.mock("../agent/model-service", () => ({
  getDefaultModel: () => ({ id: "test-model", api: "openai-completions" }),
  findModel: (id: string) => ({ id, api: "openai-completions" }),
  isUsableModelId: () => true,
  getModelRegistry: () => ({ authStorage: {} }),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
    mocks.sessionOptions.push(options);
    const listeners: Array<(event: unknown) => void> = [];
    const emit = (delta: string) => {
      for (const listener of listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
    };
    return {
      session: {
        subscribe: (listener: (event: unknown) => void) => {
          listeners.push(listener);
          return () => listeners.splice(listeners.indexOf(listener), 1);
        },
        prompt: async (prompt: string) => {
          const critic = /CRITIC_ID: (\w+)/.exec(prompt)?.[1];
          if (critic) emit(JSON.stringify({ findings: [`From ${critic}`], references: [] }));
          else if (prompt.includes("SYNTHESIS_INPUT:"))
            emit(
              JSON.stringify({
                agreements: ["ok"],
                disagreements: [],
                risks: [],
                openQuestions: [],
                references: [],
              }),
            );
          else emit(mocks.revisionOutput);
        },
        abort: () => Promise.resolve(),
        dispose: vi.fn(),
      },
    };
  }),
  createExtensionRuntime: () => ({}),
  createSyntheticSourceInfo: (path: string) => ({ path, source: "inline" }),
  SessionManager: { inMemory: () => ({}) },
  SettingsManager: { inMemory: () => ({}) },
}));

import { setHyperPlanFailureLogDir } from "../agent/harness/hyperplan";
import {
  clearHyperPlanDraftsForOwner,
  clearHyperPlanDraftsForSession,
  registerHyperPlanDraftOwner,
} from "../agent/harness/hyperplan-draft-store";
import { readPlanById, writePlan } from "../plan/plan-store";
import { IPC_CHANNELS } from "./channels";
import { registerHyperPlanIpcHandlers } from "./hyperplan-ipc";
import { registerTrustedSender } from "./trusted-sender";

const sender = { id: 7, mainFrame: { url: "file:///app/index.html" } };
const event = { sender, senderFrame: sender.mainFrame };

const baseRevision = {
  title: "Revised",
  overview: "Better plan.",
  content: "# Revised plan",
  todos: [
    { id: "todo-a", content: "Write the parser", acceptanceCriterionIds: ["ac-1"] },
    { id: "todo-b", content: "Add tests", acceptanceCriterionIds: ["ac-1"] },
  ],
  spec: {
    requirements: [{ id: "req-1", text: "Parse model output." }],
    acceptanceCriteria: [
      {
        id: "ac-1",
        requirementId: "req-1",
        description: "Fenced JSON parses.",
        todoIds: ["todo-a", "todo-b"],
      },
    ],
    assumptions: [],
    openQuestions: [],
  },
};

let logDir: string;

beforeEach(() => {
  mocks.root = mkdtempSync(join(tmpdir(), "modus-hp-flow-"));
  logDir = mkdtempSync(join(tmpdir(), "modus-hp-log-"));
  setHyperPlanFailureLogDir(logDir);
  mocks.handlers.clear();
  mocks.sessionOptions.length = 0;
  registerTrustedSender(sender, "file:///app/index.html");
  clearHyperPlanDraftsForSession("session-1");
  clearHyperPlanDraftsForOwner(sender.id);
  registerHyperPlanDraftOwner(sender.id);
  registerHyperPlanIpcHandlers({
    handle: (channel: string, handler: (...args: never[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
  } as never);
  writePlan(mocks.root, {
    workspaceId: "ws-1",
    sessionId: "session-1",
    title: "Original",
    overview: "Original overview.",
    content: "# Original",
    todos: [{ id: "todo-1", content: "Do it", acceptanceCriterionIds: ["ac-old"] }],
    spec: {
      requirements: [{ id: "req-old", text: "Old." }],
      acceptanceCriteria: [
        {
          id: "ac-old",
          requirementId: "req-old",
          description: "Old.",
          todoIds: ["todo-1"],
          status: "pending",
        },
      ],
      assumptions: [],
      openQuestions: [],
    },
  });
});

afterEach(() => {
  setHyperPlanFailureLogDir(undefined);
  rmSync(mocks.root, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

async function generateAndApply() {
  const create = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
  const choose = mocks.handlers.get(IPC_CHANNELS.agentResolveHyperPlanDraftChoice);
  if (!create || !choose) throw new Error("HyperPlan IPC handlers were not registered.");
  const preview = (await create(
    event as never,
    { sessionId: "session-1", planId: "session-1" } as never,
  )) as { draftId: string; revision: { warnings?: string[] } };
  await choose(
    event as never,
    { draftId: preview.draftId, requestId: "req-1", choice: "revision" } as never,
  );
  return { preview, plan: readPlanById(mocks.root, "session-1") };
}

describe("HyperPlan revision -> apply (real harness, draft store and plan store)", () => {
  it("applies a revision wrapped in a ```json fence with prose around it", async () => {
    mocks.revisionOutput = `Here is the revised plan:\n\n\`\`\`json\n${JSON.stringify(baseRevision, null, 2)}\n\`\`\`\nLet me know.`;
    const { preview, plan } = await generateAndApply();
    expect(preview.revision.warnings).toBeUndefined();
    expect(plan?.title).toBe("Revised");
    expect(plan?.todos.map((todo) => todo.id)).toEqual(["todo-a", "todo-b"]);
    expect(plan?.spec?.acceptanceCriteria.map((criterion) => criterion.id)).toEqual(["ac-1"]);
  });

  it("applies a revision with extra keys by stripping them", async () => {
    mocks.revisionOutput = JSON.stringify({
      ...baseRevision,
      status: "draft",
      todos: baseRevision.todos.map((todo) => ({ ...todo, status: "pending", notes: "x" })),
      spec: {
        ...baseRevision.spec,
        evidence: [],
        acceptanceCriteria: baseRevision.spec.acceptanceCriteria.map((criterion) => ({
          ...criterion,
          status: "completed",
        })),
      },
    });
    const { plan } = await generateAndApply();
    expect(plan?.title).toBe("Revised");
    expect(plan?.spec?.acceptanceCriteria[0]?.status).toBe("pending");
    expect(plan?.spec?.evidence).toEqual([]);
  });

  it("drops dangling links but keeps every todo", async () => {
    mocks.revisionOutput = JSON.stringify({
      ...baseRevision,
      todos: [
        { id: "todo-a", content: "Write the parser", acceptanceCriterionIds: ["ac-1", "ac-ghost"] },
        { id: "todo-b", content: "Add tests", acceptanceCriterionIds: ["ac-ghost"] },
      ],
      spec: {
        ...baseRevision.spec,
        acceptanceCriteria: [
          { ...baseRevision.spec.acceptanceCriteria[0], todoIds: ["todo-a", "todo-ghost"] },
          { id: "ac-orphan", requirementId: "req-ghost", description: "Orphan.", todoIds: [] },
        ],
      },
    });
    const { preview, plan } = await generateAndApply();
    expect(preview.revision.warnings).toBeUndefined();
    expect(plan?.todos.map((todo) => [todo.id, todo.acceptanceCriterionIds])).toEqual([
      ["todo-a", ["ac-1"]],
      ["todo-b", []],
    ]);
    expect(plan?.spec?.acceptanceCriteria).toEqual([
      expect.objectContaining({ id: "ac-1", todoIds: ["todo-a"] }),
    ]);
  });

  it("warns the user when a criterion ends up with no covering todo", async () => {
    mocks.revisionOutput = JSON.stringify({
      ...baseRevision,
      todos: [{ id: "todo-a", content: "Write the parser", acceptanceCriterionIds: ["ac-1"] }],
      spec: {
        ...baseRevision.spec,
        acceptanceCriteria: [
          { ...baseRevision.spec.acceptanceCriteria[0], todoIds: ["todo-a"] },
          {
            id: "ac-2",
            requirementId: "req-1",
            description: "Errors are logged locally.",
            todoIds: ["todo-ghost"],
          },
        ],
      },
    });
    const { preview, plan } = await generateAndApply();
    expect(preview.revision.warnings).toEqual([
      'No task covers the acceptance criterion "Errors are logged locally.".',
    ]);
    expect(plan?.spec?.acceptanceCriteria.map((criterion) => criterion.id)).toEqual([
      "ac-1",
      "ac-2",
    ]);
  });

  it("asks the provider for JSON output on the revision session", async () => {
    mocks.revisionOutput = JSON.stringify(baseRevision);
    await generateAndApply();
    const revisionSession = mocks.sessionOptions.at(-1) as {
      resourceLoader: {
        getExtensions(): {
          extensions: Array<{ handlers: Map<string, Array<(e: unknown) => unknown>> }>;
        };
      };
    };
    const [extension] = revisionSession.resourceLoader.getExtensions().extensions;
    const handler = extension?.handlers.get("before_provider_request")?.[0];
    expect(handler?.({ payload: { model: "m" } })).toEqual({
      model: "m",
      response_format: { type: "json_object" },
    });
    // Critics and synthesis keep their plain sessions.
    const criticSession = mocks.sessionOptions[0] as typeof revisionSession;
    expect(criticSession.resourceLoader.getExtensions().extensions).toEqual([]);
  });

  it("rejects without todos and keeps the raw output in a capped local log only", async () => {
    mocks.revisionOutput = `not json at all ${"x".repeat(40_000)}`;
    const create = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    await expect(
      create?.(event as never, { sessionId: "session-1", planId: "session-1" } as never),
    ).rejects.toThrow("The model returned an invalid revised plan. Try again.");
    const log = readFileSync(join(logDir, "hyperplan-revision-failure.log"), "utf8");
    expect(log).toContain("reason=no_json_object");
    expect(log).toContain("not json at all");
    expect(Buffer.byteLength(log, "utf8")).toBeLessThan(17 * 1024);

    mocks.revisionOutput = JSON.stringify({ ...baseRevision, todos: [] });
    await expect(
      create?.(event as never, { sessionId: "session-1", planId: "session-1" } as never),
    ).rejects.toThrow("The model returned an invalid revised plan. Try again.");
  });
});
