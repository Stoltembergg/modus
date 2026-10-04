// Regression coverage for durable Groups execution and public messages.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../shared/contracts";
import type { PromptAgentInput, PromptTurnResult } from "../agent/runtime";
import type { GroupRuntimeOptions } from "./group-runtime";

let userData: string;
vi.mock("electron", () => ({ app: { getPath: () => userData } }));
const { getDatabase } = await import("../db/database");
const { createAgentGroupWithMembers, listGroupMessages, appendGroupMessage } = await import(
  "./group-store"
);
const { GroupRuntime } = await import("./group-runtime");
await import("./group-runtime-supersede");
userData = mkdtempSync(join(tmpdir(), "modus-audit-db-"));
const instances: InstanceType<typeof GroupRuntime>[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const instance of instances.splice(0)) instance.dispose();
  getDatabase().prepare("delete from group_jobs").run();
});
afterAll(() => {
  getDatabase().close();
  rmSync(userData, { recursive: true, force: true });
});
const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};

function squad() {
  const workspaceId = crypto.randomUUID();
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      "insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at) values (?, ?, ?, ?, ?, ?)",
    )
    .run(workspaceId, "/audit/" + workspaceId, "audit", 1, now, now);
  const members = ["Alpha", "Beta", "Gamma"].map((title) => {
    const id = crypto.randomUUID();
    getDatabase()
      .prepare(
        "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, workspaceId, title, "/audit/" + workspaceId, "idle", now, now);
    return { sessionId: id };
  });
  const group = createAgentGroupWithMembers({
    name: "Squad",
    workspaceId,
    members,
    leadSessionId: members[0]!.sessionId,
    mode: "free",
  });
  return { group, a: members[0]!.sessionId, b: members[1]!.sessionId, c: members[2]!.sessionId };
}

function setup(
  updatePending = false,
  options: Omit<Partial<GroupRuntimeOptions>, "runtime" | "host"> = {},
) {
  const calls: Array<{ input: PromptAgentInput; resolve: (value: PromptTurnResult) => void }> = [];
  const aborted: string[] = [];
  const listeners = new Set<(event: AgentEvent) => void>();
  const runtime = {
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    prompt: (_window: unknown, input: PromptAgentInput): Promise<PromptTurnResult> =>
      new Promise((resolve) => calls.push({ input, resolve })),
    abort: async (id: string) => {
      aborted.push(id);
      calls.find((call) => call.input.sessionId === id)?.resolve({ outcome: "aborted" });
    },
    isSessionStreaming: () => false,
    onTurnSettled: () => () => {},
    onQuestionPending: () => () => {},
  };
  const state = { windowAvailable: true };
  const host = {
    getWindow: () => (state.windowAvailable ? ({} as never) : undefined),
    isUpdatePending: () => updatePending,
    emit: () => {},
  };
  const groups = new GroupRuntime({ runtime, host, ...options });
  instances.push(groups);
  return {
    groups,
    runtime,
    calls,
    aborted,
    host,
    state,
    emit: (event: AgentEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("Groups runtime audit", () => {
  it("F03 times out hanging turns so another group can run", async () => {
    vi.useFakeTimers();
    const first = squad();
    const second = squad();
    const env = setup(false, { turnTimeoutMs: 1_000 });
    env.groups.postUserMessage({ groupId: first.group.id, body: "@Alpha @Beta execute" });
    env.groups.postUserMessage({ groupId: second.group.id, body: "@Alpha execute" });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(env.calls.some((call) => call.input.sessionId === second.a)).toBe(true);
    expect(env.aborted).toEqual(expect.arrayContaining([first.a, first.b]));
  });
  it("F04 a message saved while updating retains its pending wake after runtime reconstruction", () => {
    const { group } = squad();
    const env = setup(true);
    env.groups.postUserMessage({ groupId: group.id, body: "@Alpha execute after update" });
    expect(env.groups.isGroupWorking(group.id)).toBe(true);
    env.groups.dispose();
    const reconstructed = new GroupRuntime({
      runtime: env.runtime,
      host: { ...env.host, isUpdatePending: () => false },
      recoverPending: true,
    });
    instances.push(reconstructed);
    reconstructed.kick();
    expect(listGroupMessages(group.id).some((m) => m.body.includes("execute after update"))).toBe(
      true,
    );
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]!.input.sessionId).toBe(group.leadSessionId);
  });
  it("F04 recovers admitted queue entries after a resource limit across app restart", async () => {
    const { group, a, b } = squad();
    const env = setup(false, {
      limits: { maxAgentMessages: 1 },
      maxConcurrentTurns: 1,
    });
    const user = env.groups.postUserMessage({
      groupId: group.id,
      body: "@Alpha @Beta @Gamma complete the shared task",
    });
    expect(env.calls.map((call) => call.input.sessionId)).toEqual([a]);

    env.state.windowAvailable = false;
    env.calls[0]!.resolve({ outcome: "ok", finalText: "Alpha finished." });
    await flush();
    expect(
      listGroupMessages(group.id)
        .filter((message) => message.authorSessionId === b)
        .every((message) => message.status !== "cancelled"),
    ).toBe(true);

    env.groups.dispose();
    env.state.windowAvailable = true;
    const recovered = new GroupRuntime({
      runtime: env.runtime,
      host: env.host,
      recoverPending: true,
      maxConcurrentTurns: 1,
    });
    instances.push(recovered);
    recovered.kick();

    expect(env.calls.map((call) => call.input.sessionId)).toEqual([a, b]);
    expect(listGroupMessages(group.id).find((message) => message.id === user.id)).toBeTruthy();
  });
  it("F06 Stop aborts a member whose only turn is gated on a question", () => {
    const { group, a } = squad();
    const env = setup();
    env.groups.postUserMessage({ groupId: group.id, body: "@Alpha execute" });
    env.groups.handleQuestionPending(a);
    env.groups.stopGroup(group.id);
    expect(env.aborted).toEqual([a]);
    expect(env.groups.memberStates().flatMap((s) => s.waitingSessionIds)).toEqual([]);
    expect(listGroupMessages(group.id).some((m) => m.body === "Stopped by you")).toBe(true);
  });
  it("F09 naming a peer in an otherwise Ready-for-you response does not wake the peer", async () => {
    const { group, b } = squad();
    const env = setup();
    env.groups.postUserMessage({ groupId: group.id, body: "@Alpha summarize" });
    env.calls[0]!.resolve({
      outcome: "ok",
      finalText: "O @Beta participou da análise.\nReady for you",
    });
    await flush();
    expect(env.calls).toHaveLength(1);
  });
  it("F10 a queued prompt includes collaboration completed while it waited", async () => {
    const { group, a, b, c } = squad();
    const env = setup();
    env.groups.postUserMessage({ groupId: group.id, body: "@Alpha primeiro" });
    // The explicit busy target is reported; it is not silently substituted or queued.
    env.groups.postUserMessage({ groupId: group.id, body: "@Alpha segundo" });
    expect(env.calls.filter((call) => call.input.sessionId === a)).toHaveLength(1);
    expect(listGroupMessages(group.id).at(-1)?.body).toContain("member-unavailable");
    env.groups.postUserMessage({ groupId: group.id, body: "@Beta descubra" });
    env.groups.postUserMessage({ groupId: group.id, body: "@Gamma aguarde" });
    env.calls
      .find((call) => call.input.sessionId === b)!
      .resolve({ outcome: "ok", finalText: "DADO_NOVO_RELEVANTE\nAgreed" });
    await flush();
    const queued = env.calls.filter((call) => call.input.sessionId === c).at(-1)!;
    expect(queued.input.message).toContain("segundo");
    expect(queued.input.message).toContain("DADO_NOVO_RELEVANTE");
  });

  it("F01 keeps distinct public messages in one turn and finalizes the original card by identity", async () => {
    const { group, a } = squad();
    const env = setup();
    env.groups.postUserMessage({ groupId: group.id, body: "@Alpha implement" });
    const firstId = listGroupMessages(group.id).find((m) => m.authorKind === "agent")?.id;
    env.emit({ type: "run.started", sessionId: a, runId: "run-a", delivery: "normal" });
    env.emit({ type: "message.started", sessionId: a, messageId: "user", role: "user" });
    env.emit({ type: "message.delta", sessionId: a, messageId: "user", delta: "PRIVATE PROMPT" });
    env.emit({ type: "thinking.delta", sessionId: a, messageId: "one", delta: "PRIVATE THOUGHT" });
    env.emit({ type: "message.started", sessionId: a, messageId: "one", role: "assistant" });
    env.emit({
      type: "message.delta",
      sessionId: a,
      messageId: "one",
      delta: "First public message.",
    });
    env.emit({ type: "message.completed", sessionId: a, messageId: "one" });
    env.emit({ type: "message.started", sessionId: a, messageId: "two", role: "assistant" });
    env.emit({
      type: "message.delta",
      sessionId: a,
      messageId: "two",
      delta: "Second public message.",
    });
    env.calls[0]!.resolve({ outcome: "ok", finalText: "Second public message." });
    await flush();
    const publicMessages = listGroupMessages(group.id).filter(
      (m) => m.authorKind === "agent" && m.kind === "message",
    );
    expect(publicMessages.map((m) => m.body)).toEqual([
      "First public message.",
      "Second public message.",
    ]);
    expect(publicMessages[0]!.id).toBe(firstId);
    expect(
      publicMessages.every((m) => m.status === "completed" && m.turnId && m.runId === "run-a"),
    ).toBe(true);
    expect(new Set(publicMessages.map((m) => m.id)).size).toBe(2);
  });

  it("F03 ignores late output after cancellation while allowing other groups to proceed", async () => {
    const { group, a } = squad();
    const env = setup();
    env.groups.postUserMessage({ groupId: group.id, body: "@Alpha execute" });
    env.emit({ type: "run.started", sessionId: a, runId: "late", delivery: "normal" });
    env.emit({ type: "message.started", sessionId: a, messageId: "one", role: "assistant" });
    env.emit({ type: "message.delta", sessionId: a, messageId: "one", delta: "Partial." });
    env.groups.stopGroup(group.id);
    env.emit({ type: "message.delta", sessionId: a, messageId: "one", delta: "LATE OUTPUT" });
    await flush();
    const card = listGroupMessages(group.id).find((m) => m.sdkMessageId === "one");
    expect(card?.body).toBe("Partial.");
    expect(card?.status).toBe("cancelled");
  });

  it("F03 gives the next free slot to another group rather than draining the first group", async () => {
    const first = squad();
    const second = squad();
    const env = setup(false, { maxConcurrentTurns: 1 });
    env.groups.postUserMessage({ groupId: first.group.id, body: "@Alpha first" });
    env.groups.postUserMessage({ groupId: first.group.id, body: "@Beta second" });
    env.groups.postUserMessage({ groupId: second.group.id, body: "@Alpha other group" });
    env.calls[0]!.resolve({ outcome: "ok", finalText: "Done." });
    await flush();
    expect(env.calls[1]?.input.sessionId).toBe(second.a);
  });

  it("F04 marks a running turn interrupted and never reruns it automatically after reconstruction", () => {
    const { group, a } = squad();
    const env = setup();
    env.groups.postUserMessage({ groupId: group.id, body: "@Alpha change files" });
    env.groups.dispose();
    const recovered = new GroupRuntime({
      runtime: env.runtime,
      host: env.host,
      recoverPending: true,
    });
    instances.push(recovered);
    recovered.kick();
    expect(env.calls.filter((call) => call.input.sessionId === a)).toHaveLength(1);
    expect(listGroupMessages(group.id).find((m) => m.turnId)?.status).toBe("interrupted");
  });

  it("F04b resumes an interrupted turn by execution id without posting a user message", async () => {
    const { group, a } = squad();
    const env = setup();
    env.groups.postUserMessage({
      groupId: group.id,
      body: "@Alpha ship the feature",
      attachments: [{ type: "image", mimeType: "image/png", data: "abc", name: "shot.png" }],
    });
    const before = listGroupMessages(group.id);
    expect(before.some((m) => m.authorKind === "user")).toBe(true);
    env.groups.dispose();
    const recovered = new GroupRuntime({
      runtime: env.runtime,
      host: env.host,
      recoverPending: true,
    });
    instances.push(recovered);
    const card = listGroupMessages(group.id).find((m) => m.turnId && m.status === "interrupted");
    expect(card?.turnId).toBeTruthy();
    const userCountBefore = listGroupMessages(group.id).filter(
      (m) => m.authorKind === "user",
    ).length;
    recovered.resumeExecution({ groupId: group.id, executionId: card!.turnId! });
    expect(listGroupMessages(group.id).filter((m) => m.authorKind === "user")).toHaveLength(
      userCountBefore,
    );
    expect(listGroupMessages(group.id).some((m) => m.body === "Resume this task.")).toBe(false);
    expect(env.calls.filter((call) => call.input.sessionId === a)).toHaveLength(2);
    const resumed = env.calls[1]!;
    expect(resumed.input.message).toContain("ship the feature");
    expect(resumed.input.attachments).toEqual([
      expect.objectContaining({ type: "image", mimeType: "image/png", data: "abc" }),
    ]);
    expect(listGroupMessages(group.id).find((m) => m.turnId === card!.turnId)?.status).toBe(
      "running",
    );
    resumed.resolve({ outcome: "ok", finalText: "Continued from checkpoint." });
    await flush();
    expect(listGroupMessages(group.id).find((m) => m.turnId === card!.turnId)).toMatchObject({
      body: "Continued from checkpoint.",
      status: "completed",
      chainId: card!.chainId,
      turnId: card!.turnId,
    });
  });

  it("F04 commits a user request and its queue atomically", () => {
    const { group } = squad();
    const env = setup();
    const db = getDatabase();
    db.exec(
      "create trigger reject_group_job before insert on group_jobs begin select raise(abort, 'queue unavailable'); end",
    );
    try {
      expect(() =>
        env.groups.postUserMessage({ groupId: group.id, body: "@Alpha execute" }),
      ).toThrow("queue unavailable");
      expect(listGroupMessages(group.id)).toEqual([]);
      expect(env.groups.isGroupWorking(group.id)).toBe(false);
      expect(env.calls).toHaveLength(0);
    } finally {
      db.exec("drop trigger reject_group_job");
    }
  });

  it("F07 uses the same stable order for cards and every older page", () => {
    const { group } = squad();
    for (let index = 1; index <= 120; index++)
      appendGroupMessage({
        id: `same-time-${String(121 - index).padStart(3, "0")}`,
        groupId: group.id,
        authorKind: "user",
        body: `Message ${index}`,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
    let page = listGroupMessages(group.id, { limit: 50 });
    const seen = [...page];
    while (page.length) {
      const first = page[0]!;
      page = listGroupMessages(group.id, {
        before: { createdAt: first.createdAt, id: first.id },
        limit: 50,
      });
      seen.unshift(...page);
      if (seen.length > 120) throw new Error("Repeated older page");
    }
    expect(seen.map((m) => m.sequence)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  });

  it("F01 does not create public cards for thought-only and tool-only SDK messages", async () => {
    const { group, a } = squad();
    const env = setup();
    env.groups.postUserMessage({ groupId: group.id, body: "@Alpha execute" });
    for (const messageId of ["thinking", "tool"]) {
      env.emit({ type: "message.started", sessionId: a, messageId, role: "assistant" });
      env.emit({ type: "message.completed", sessionId: a, messageId });
    }
    env.emit({ type: "message.started", sessionId: a, messageId: "public", role: "assistant" });
    env.emit({ type: "message.delta", sessionId: a, messageId: "public", delta: "Useful result." });
    env.calls[0]!.resolve({ outcome: "ok", finalText: "Useful result." });
    await flush();
    const cards = listGroupMessages(group.id).filter((m) => m.turnId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      sdkMessageId: "public",
      body: "Useful result.",
      status: "completed",
    });
  });

  it("F03 ignores structured delegation from a cancelled turn that has not settled", () => {
    const { group, a, b } = squad();
    const env = setup();
    env.runtime.abort = async (id) => {
      env.aborted.push(id);
    };
    env.groups.postUserMessage({ groupId: group.id, body: "@Alpha execute" });
    env.groups.stopGroup(group.id);
    expect(
      env.groups.handleTaskWake({
        groupId: group.id,
        actorSessionId: a,
        targetSessionId: b,
        body: "Handoff late",
      }),
    ).toBeUndefined();
    expect(env.calls).toHaveLength(1);
  });

  it("F02 folded history exposes the last durable cursor for repeated identical chunks", async () => {
    const { a } = squad();
    const { recordAgentEvent, listAgentEvents } = await import("../agent/agent-event-store");
    recordAgentEvent({ type: "run.started", sessionId: a, runId: "cursor", delivery: "normal" });
    recordAgentEvent({ type: "message.started", sessionId: a, messageId: "m", role: "assistant" });
    recordAgentEvent({ type: "message.delta", sessionId: a, messageId: "m", delta: "same" });
    const cursor = recordAgentEvent({
      type: "message.delta",
      sessionId: a,
      messageId: "m",
      delta: "same",
    });
    const folded = listAgentEvents(a).find((item) => item.event.type === "message.delta");
    expect(folded?.event).toMatchObject({ delta: "samesame", eventCursor: cursor });
  });
});

const { runGroupTool, runGroupVerifiedTool, setGroupTaskWakeSink } = await import(
  "../agent/tools/group-tools"
);
const { hasGroupTaskExplicitDispatch } = await import("./group-task-store");
const { listGroupDecisions } = await import("./group-store");

it.each([
  "handoff",
  "taskless-handoff",
  "taskless-agree",
] as const)("retries %s after an actual runtime status persistence failure", async (kind) => {
  const { group, a, b } = squad();
  const env = setup(true);
  const operationId = crypto.randomUUID();
  setGroupTaskWakeSink((wake) => env.groups.handleTaskWake(wake));
  const invoke = () =>
    kind !== "taskless-agree"
      ? runGroupTool(
          "group_handoff",
          { sessionId: a },
          {
            memberId: b,
            objective: "Durable objective",
            ...(kind === "handoff" ? { taskTitle: "Delivery retry" } : {}),
            operationId,
          },
        )
      : runGroupVerifiedTool(
          "group_agree",
          { sessionId: a },
          { note: "Durable agreement", operationId },
        );
  const db = getDatabase();
  db.exec(
    "create trigger fail_task_status before insert on group_messages when new.kind = 'status' begin select raise(abort, 'status unavailable'); end",
  );
  try {
    await invoke();
    expect(hasGroupTaskExplicitDispatch(operationId)).toBe(false);
    expect(listGroupMessages(group.id).filter((message) => message.kind === "status")).toHaveLength(
      0,
    );
  } finally {
    db.exec("drop trigger fail_task_status");
  }
  try {
    await invoke();
    await invoke();
    expect(hasGroupTaskExplicitDispatch(operationId)).toBe(true);
    expect(listGroupMessages(group.id).filter((message) => message.kind === "status")).toHaveLength(
      1,
    );
    if (kind === "taskless-agree") expect(listGroupDecisions(group.id)).toHaveLength(1);
    else
      expect(db.prepare("select id from group_jobs where group_id = ?").all(group.id)).toHaveLength(
        1,
      );
  } finally {
    setGroupTaskWakeSink(undefined);
  }
});

it("reuses durable task delivery after post-commit emit failure and runtime reconstruction", () => {
  const { group, a, b } = squad();
  const env = setup(true);
  const wake = {
    groupId: group.id,
    actorSessionId: a,
    targetSessionId: b,
    body: "Durable wake",
    operationId: crypto.randomUUID(),
    sourceEventId: crypto.randomUUID(),
  };
  const emit = vi.spyOn(env.host, "emit").mockImplementationOnce(() => {
    throw new Error("emit after commit failed");
  });
  expect(() => env.groups.handleTaskWake(wake)).toThrow("emit after commit failed");
  const before = listGroupMessages(group.id);
  const jobs = getDatabase().prepare("select * from group_jobs where group_id = ?").all(group.id);
  const chains = getDatabase()
    .prepare("select * from group_execution_chains where group_id = ?")
    .all(group.id);
  expect(jobs).toHaveLength(1);
  emit.mockRestore();
  env.groups.dispose();
  const recovered = new GroupRuntime({
    runtime: env.runtime,
    host: env.host,
    recoverPending: true,
  });
  instances.push(recovered);
  expect(recovered.handleTaskWake(wake)?.id).toBe(
    before.find((message) => message.body === wake.body)?.id,
  );
  const persistedMessages = (messages: typeof before) =>
    messages.map(({ id, body, kind, status }) => ({ id, body, kind, status }));
  expect(persistedMessages(listGroupMessages(group.id))).toEqual(persistedMessages(before));
  expect(
    getDatabase().prepare("select * from group_jobs where group_id = ?").all(group.id),
  ).toEqual(jobs);
  expect(
    getDatabase().prepare("select * from group_execution_chains where group_id = ?").all(group.id),
  ).toEqual(chains);
  expect(() => recovered.handleTaskWake({ ...wake, body: "Conflicting payload" })).toThrow(
    "Operation",
  );
});

it("does not duplicate a tool wake when acknowledgement is lost after durable commit", () => {
  const { group, a, b } = squad();
  const env = setup(true);
  let attempts = 0;
  setGroupTaskWakeSink((wake) => {
    const ack = env.groups.handleTaskWake(wake);
    attempts++;
    return attempts === 1 ? undefined : ack;
  });
  const operationId = crypto.randomUUID();
  const invoke = () =>
    runGroupTool(
      "group_handoff",
      { sessionId: a },
      { memberId: b, objective: "Ack loss", taskTitle: "Already durable", operationId },
    );
  try {
    expect(invoke()).toContain("not acknowledged");
    expect(hasGroupTaskExplicitDispatch(operationId)).toBe(true);
    expect(invoke()).toContain("[in_progress]");
    expect(attempts).toBe(2);
    expect(listGroupMessages(group.id).filter((message) => message.kind === "status")).toHaveLength(
      1,
    );
    expect(
      getDatabase().prepare("select id from group_jobs where group_id = ?").all(group.id),
    ).toHaveLength(1);
  } finally {
    setGroupTaskWakeSink(undefined);
  }
});

it("republishes the persisted message on runtime replay after post-commit event failure", () => {
  const { group, a, b } = squad();
  const env = setup(true);
  const wake = {
    groupId: group.id,
    actorSessionId: a,
    targetSessionId: b,
    body: "Live delivery retry",
    operationId: crypto.randomUUID(),
    sourceEventId: crypto.randomUUID(),
  };
  const emit = vi.spyOn(env.host, "emit").mockImplementationOnce(() => {
    throw new Error("live event failed");
  });
  try {
    expect(() => env.groups.handleTaskWake(wake)).toThrow("live event failed");
    const persisted = listGroupMessages(group.id).find((message) => message.body === wake.body);
    const messages = listGroupMessages(group.id);
    const jobs = getDatabase().prepare("select * from group_jobs where group_id = ?").all(group.id);
    const budgets = getDatabase()
      .prepare("select * from group_execution_chains where group_id = ?")
      .all(group.id);
    emit.mockClear();
    expect(env.groups.handleTaskWake(wake)).toEqual(persisted);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "group.message", message: persisted }),
    );
    expect(listGroupMessages(group.id)).toEqual(messages);
    expect(
      getDatabase().prepare("select * from group_jobs where group_id = ?").all(group.id),
    ).toEqual(jobs);
    expect(
      getDatabase()
        .prepare("select * from group_execution_chains where group_id = ?")
        .all(group.id),
    ).toEqual(budgets);
  } finally {
    emit.mockRestore();
  }
});

it("tool retry republishes a committed dispatch after live event failure", () => {
  const { group, a, b } = squad();
  const env = setup(true);
  const operationId = crypto.randomUUID();
  setGroupTaskWakeSink((wake) => env.groups.handleTaskWake(wake));
  const emit = vi.spyOn(env.host, "emit").mockImplementationOnce(() => {
    throw new Error("tool live event failed");
  });
  const invoke = () =>
    runGroupTool(
      "group_handoff",
      { sessionId: a },
      {
        memberId: b,
        objective: "Republish tool status",
        taskTitle: "Already committed",
        operationId,
      },
    );
  try {
    expect(invoke()).toContain("tool live event failed");
    expect(hasGroupTaskExplicitDispatch(operationId)).toBe(true);
    const messages = listGroupMessages(group.id);
    const persisted = messages.find((message) => message.kind === "status");
    const jobs = getDatabase().prepare("select * from group_jobs where group_id = ?").all(group.id);
    const budgets = getDatabase()
      .prepare("select * from group_execution_chains where group_id = ?")
      .all(group.id);
    emit.mockClear();
    expect(invoke()).toContain("[in_progress]");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "group.message", message: persisted }),
    );
    expect(listGroupMessages(group.id)).toEqual(messages);
    expect(
      getDatabase().prepare("select * from group_jobs where group_id = ?").all(group.id),
    ).toEqual(jobs);
    expect(
      getDatabase()
        .prepare("select * from group_execution_chains where group_id = ?")
        .all(group.id),
    ).toEqual(budgets);
  } finally {
    emit.mockRestore();
    setGroupTaskWakeSink(undefined);
  }
});
