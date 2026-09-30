import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GroupRuntimeEvent } from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../db/database");
const { ensureChatsWorkspace } = await import("../workspace/workspace-store");
const { createAgentGroupWithMembers } = await import("./group-store");
const { GroupRuntime } = await import("./group-runtime");
// Side-effect: patch postUserMessage to clear sticky Waiting for you.
await import("./group-runtime-supersede");

type PromptTurnResult = import("../agent/runtime").PromptTurnResult;
type PromptAgentInput = import("../agent/runtime").PromptAgentInput;
type TurnSettledEvent = import("../agent/runtime").TurnSettledEvent;

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function insertWorkspace(): string {
  const id = uid("ws");
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `root-${id}`, "repo", 1, now, now);
  return id;
}

function insertSession(workspaceId: string, title: string): string {
  const id = uid("s");
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, workspaceId, title, `root-${workspaceId}`, "idle", now, now);
  return id;
}

function squad() {
  const ws = insertWorkspace();
  const alpha = insertSession(ws, "Alpha");
  const beta = insertSession(ws, "Beta");
  const gamma = insertSession(ws, "Gamma");
  const group = createAgentGroupWithMembers({
    name: "Squad",
    workspaceId: ws,
    members: [{ sessionId: alpha }, { sessionId: beta }, { sessionId: gamma }],
    leadSessionId: alpha,
  });
  return { group, alpha, beta, gamma };
}

type Call = {
  input: PromptAgentInput;
  resolve(result: PromptTurnResult): void;
  reject(error: unknown): void;
};

class FakeAgentRuntime {
  calls: Call[] = [];
  started: string[] = [];
  streaming = new Set<string>();
  aborted: string[] = [];
  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
    const index = this.calls.findIndex((call) => call.input.sessionId === sessionId);
    if (index < 0) return;
    const [call] = this.calls.splice(index, 1);
    call?.resolve({ outcome: "aborted" });
  }
  prompt(_window: unknown, input: PromptAgentInput): Promise<PromptTurnResult> {
    this.started.push(input.sessionId);
    return new Promise((resolve, reject) => this.calls.push({ input, resolve, reject }));
  }
  isSessionStreaming(sessionId: string): boolean {
    return this.streaming.has(sessionId);
  }
  settledListeners = new Set<(event: TurnSettledEvent) => void>();
  questionListeners = new Set<(sessionId: string) => void>();
  onTurnSettled(listener: (event: TurnSettledEvent) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }
  onQuestionPending(listener: (sessionId: string) => void): () => void {
    this.questionListeners.add(listener);
    return () => this.questionListeners.delete(listener);
  }
  openGate(sessionId: string): void {
    for (const listener of this.questionListeners) listener(sessionId);
  }
  take(sessionId: string): Call {
    const index = this.calls.findIndex((call) => call.input.sessionId === sessionId);
    if (index < 0) throw new Error(`no pending prompt for ${sessionId}`);
    const [call] = this.calls.splice(index, 1);
    return call as Call;
  }
  pendingSessions(): string[] {
    return this.calls.map((call) => call.input.sessionId);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const created: InstanceType<typeof GroupRuntime>[] = [];

function setup() {
  const runtime = new FakeAgentRuntime();
  const events: GroupRuntimeEvent[] = [];
  const groups = new GroupRuntime({
    runtime,
    host: {
      getWindow: () => ({}) as never,
      isUpdatePending: () => false,
      emit: (event) => events.push(event),
    },
    retryDelayMs: 5,
  });
  created.push(groups);
  return { runtime, groups, events };
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-group-supersede-"));
  ensureChatsWorkspace();
});

afterEach(() => {
  for (const runtime of created.splice(0)) runtime.dispose();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("group-runtime-supersede: clear sticky Waiting for you", () => {
  it("clears a gated member so Waiting for you does not stick while the lead continues", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups, events } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    runtime.take(alpha).resolve({
      outcome: "ok",
      finalText: "I am lead. @Beta please implement.",
    });
    await flush();
    expect(runtime.pendingSessions()).toEqual([beta]);
    runtime.openGate(beta);
    expect(groups.memberStates()).toEqual([
      expect.objectContaining({ groupId: group.id, waitingSessionIds: [beta] }),
    ]);

    groups.postUserMessage({ groupId: group.id, body: "please draft the plan" });
    await flush();
    expect(runtime.aborted).toContain(beta);
    expect(
      groups.memberStates().find((entry) => entry.groupId === group.id)?.waitingSessionIds,
    ).toEqual([]);
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(events.filter((event) => event.type === "group.activity").at(-1)).toMatchObject({
      groupId: group.id,
      waitingSessionIds: [],
      runningSessionIds: [alpha],
    });
  });

  it("clears HyperPlan awaitingUser and can re-wake that member from the room", async () => {
    const { group, beta } = squad();
    const { reserveHyperPlanSession } = await import("../agent/harness/hyperplan-draft-store");
    expect(reserveHyperPlanSession({ sessionId: beta, ownerId: 1 })).toBe(true);
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Beta plan" });
    runtime.take(beta).resolve({ outcome: "blocked" });
    await flush();
    expect(groups.isAwaitingUser(beta)).toBe(true);

    groups.postUserMessage({ groupId: group.id, body: "@Beta try again" });
    await flush();
    expect(groups.isAwaitingUser(beta)).toBe(false);
    expect(
      groups.memberStates().find((entry) => entry.groupId === group.id)?.waitingSessionIds,
    ).toEqual([]);
    expect(runtime.pendingSessions()).toEqual([beta]);
  });

  it("re-wakes a previously gated member when the new message mentions them", async () => {
    const { group, beta } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Beta go" });
    runtime.openGate(beta);
    expect(groups.memberStates()[0]?.waitingSessionIds).toEqual([beta]);

    groups.postUserMessage({ groupId: group.id, body: "@Beta continue" });
    await flush();
    expect(
      groups.memberStates().find((entry) => entry.groupId === group.id)?.waitingSessionIds,
    ).toEqual([]);
    expect(runtime.pendingSessions()).toEqual([beta]);
  });
});
