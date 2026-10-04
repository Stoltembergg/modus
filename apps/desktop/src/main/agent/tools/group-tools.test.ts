import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseGroupCollabStatusLine } from "../../../shared/group-collab-status";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));
vi.mock("../../git/git-service", async (original) => ({
  ...(await original<typeof import("../../git/git-service")>()),
  getGroupSourceFingerprint: vi.fn(async () => "current-source"),
}));

const { getDatabase } = await import("../../db/database");
const { setAgentArchived } = await import("../../agents/agents-store");
const { ensureChatsWorkspace } = await import("../../workspace/workspace-store");
const {
  appendGroupMessage,
  createAgentGroupWithMembers,
  GROUP_DECISION_LIMIT,
  listGroupDecisions,
  listGroupMessages,
  listGroupTasks,
  removeAgentGroupMember,
  setAgentGroupLead,
  setAgentGroupMode,
} = await import("../../groups/group-store");
const {
  GROUP_READ_MESSAGES_MAX_LIMIT,
  GROUP_READ_MESSAGES_MAX_TOKENS,
  GROUP_TOOL_NAMES,
  registerGroupTools,
  runGroupTool,
  runGroupVerifiedTool,
  setGroupTaskWakeSink,
} = await import("./group-tools");
const taskStore = await import("../../groups/group-task-store");
const taskEvidence = await import("../../groups/group-task-evidence");
const { estimateGroupTokens } = await import("../../groups/group-runtime");
const { toolRegistry } = await import("./registry");
const { setAgentToolContext } = await import("./tool-context");

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
  const loner = insertSession(ws, "Loner");
  const group = createAgentGroupWithMembers({
    name: "Squad",
    workspaceId: ws,
    members: [{ sessionId: alpha }, { sessionId: beta }],
    leadSessionId: alpha,
  });
  return { ws, group, alpha, beta, loner };
}

const wakes: unknown[] = [];

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-group-tools-test-"));
  ensureChatsWorkspace();
});

afterEach(() => {
  wakes.length = 0;
  setGroupTaskWakeSink(undefined);
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

function taskIdFrom(text: string): string {
  const id = /task (\S+) \[/.exec(text)?.[1];
  if (!id) throw new Error(`no task id in: ${text}`);
  return id;
}

describe("group member tools", () => {
  it("run the task flow through the store and route review / changes wakes", async () => {
    const { group, alpha, beta } = squad();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const a = { sessionId: alpha, groupId: group.id };
    const b = { sessionId: beta, groupId: group.id };

    const created = runGroupTool("group_create_task", a, { title: "Parser", reviewer: "@beta" });
    expect(created).toMatch(/^Created task \S+ \[open\] "Parser" owner=none reviewer=@Beta$/);
    const id = taskIdFrom(created);
    expect(runGroupTool("group_list_tasks", b, { status: "open" })).toContain(`task ${id} [open]`);
    expect(runGroupTool("group_list_tasks", b, { status: "done" })).toBe("No tasks.");

    expect(runGroupTool("group_claim_task", a, { id })).toContain("[in_progress]");
    expect(runGroupTool("group_request_review", a, { id, reviewer: "Beta" })).toContain(
      "Review requested from @Beta",
    );
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: alpha,
        targetSessionId: beta,
        body: `Review requested: "Parser" (task ${id}) @Beta`,
      },
    ]);

    expect(
      await runGroupVerifiedTool("group_review_task", b, {
        id,
        verdict: "changes",
        note: "add tests",
      }),
    ).toContain("Changes requested: task");
    expect(wakes.at(-1)).toEqual({
      groupId: group.id,
      actorSessionId: beta,
      targetSessionId: alpha,
      body: `Changes requested on "Parser" (task ${id}) @Alpha: add tests`,
    });

    runGroupTool("group_request_review", a, { id, reviewer: beta });
    expect(
      await runGroupVerifiedTool("group_review_task", b, { id, verdict: "approve" }),
    ).toContain("Approved: task");
    // Approve only records a status for the owner (wake: false), without a note just "Approved".
    expect(wakes).toHaveLength(4);
    expect(wakes.at(-1)).toEqual({
      groupId: group.id,
      actorSessionId: beta,
      targetSessionId: alpha,
      body: "Approved",
      wake: false,
    });
    expect(listGroupTasks(group.id)[0]?.status).toBe("done");

    // Release path.
    const other = taskIdFrom(runGroupTool("group_create_task", b, { title: "Docs" }));
    runGroupTool("group_claim_task", b, { id: other });
    expect(runGroupTool("group_release_task", b, { id: other })).toContain("[open]");
  });

  it("approve with a note records the note in the status", async () => {
    const { group, alpha, beta } = squad();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const a = { sessionId: alpha, groupId: group.id };
    const b = { sessionId: beta, groupId: group.id };
    const id = taskIdFrom(runGroupTool("group_create_task", a, { title: "T" }));
    runGroupTool("group_claim_task", a, { id });
    runGroupTool("group_request_review", a, { id, reviewer: "Beta" });
    await runGroupVerifiedTool("group_review_task", b, {
      id,
      verdict: "approve",
      note: "  looks good ",
    });
    expect(wakes.at(-1)).toMatchObject({ body: "Approved: looks good", wake: false });
  });

  it("the suggested reviewer may claim; the claim clears the reviewer; self-review still applies", async () => {
    const { group, alpha, beta } = squad();
    const a = { sessionId: alpha, groupId: group.id };
    const b = { sessionId: beta, groupId: group.id };
    const id = taskIdFrom(runGroupTool("group_create_task", a, { title: "T", reviewer: "Beta" }));
    expect(runGroupTool("group_claim_task", b, { id })).toMatch(
      /\[in_progress\] "T" owner=@Beta reviewer=none$/,
    );
    expect(runGroupTool("group_request_review", b, { id, reviewer: "Beta" })).toMatch(
      /^\[group-error:self-review\] /,
    );
    expect(runGroupTool("group_request_review", b, { id, reviewer: "Alpha" })).toContain(
      "Review requested from @Alpha",
    );
  });

  it("members resolve by their unique agent name: same-titled chats become Twin and twin 2", async () => {
    const ws = insertWorkspace();
    const lead = insertSession(ws, "Lead");
    const twinA = insertSession(ws, "Twin");
    const twinB = insertSession(ws, "twin");
    const group = createAgentGroupWithMembers({
      name: "Twins",
      workspaceId: ws,
      members: [{ sessionId: lead }, { sessionId: twinA }, { sessionId: twinB }],
      leadSessionId: lead,
    });
    const caller = { sessionId: lead, groupId: group.id };
    const id = taskIdFrom(runGroupTool("group_create_task", caller, { title: "T" }));
    runGroupTool("group_claim_task", caller, { id });
    // No ambiguity any more (agent names are unique); "twin 2" and ids resolve too.
    expect(runGroupTool("group_request_review", caller, { id, reviewer: "@TWIN" })).toContain(
      "Review requested from @Twin",
    );
    const other = taskIdFrom(runGroupTool("group_create_task", caller, { title: "U" }));
    runGroupTool("group_claim_task", caller, { id: other });
    expect(
      runGroupTool("group_request_review", caller, { id: other, reviewer: "twin 2" }),
    ).toContain("Review requested from @twin 2");
    expect(listGroupTasks(group.id).map((task) => task.reviewerSessionId)).toEqual([twinA, twinB]);
  });

  it("returns store errors as [group-error:<code>] text and never throws", async () => {
    const { group, alpha, beta, loner } = squad();
    const a = { sessionId: alpha, groupId: group.id };
    const b = { sessionId: beta, groupId: group.id };
    const id = taskIdFrom(runGroupTool("group_create_task", a, { title: "T" }));
    runGroupTool("group_claim_task", a, { id });

    expect(runGroupTool("group_claim_task", b, { id })).toMatch(/^\[group-error:task-taken\] /);
    expect(runGroupTool("group_release_task", b, { id })).toMatch(/^\[group-error:not-owner\] /);
    expect(runGroupTool("group_request_review", a, { id, reviewer: "Alpha" })).toMatch(
      /^\[group-error:self-review\] /,
    );
    expect(runGroupTool("group_request_review", a, { id, reviewer: "Loner" })).toMatch(
      /^\[group-error:not-a-member\] /,
    );
    expect(await runGroupVerifiedTool("group_review_task", b, { id, verdict: "approve" })).toMatch(
      /^\[group-error:not-reviewer\] /,
    );
    runGroupTool("group_request_review", a, { id, reviewer: "Beta" });
    expect(runGroupTool("group_release_task", a, { id })).toMatch(
      /^\[group-error:invalid-transition\] /,
    );
    expect(runGroupTool("group_claim_task", a, { id: "missing" })).toMatch(
      /^\[group-error:task-not-found\] /,
    );
    expect(
      await runGroupVerifiedTool("group_review_task", b, { id, verdict: "close" as "approve" }),
    ).toMatch(/^\[group-error:invalid-value\] /);
    // A caller outside any group, or one that left mid-turn.
    expect(runGroupTool("group_list_tasks", { sessionId: loner }, {})).toMatch(
      /^\[group-error:not-a-member\] /,
    );
    removeAgentGroupMember(group.id, beta);
    expect(runGroupTool("group_list_tasks", b, {})).toMatch(/^\[group-error:not-a-member\] /);
  });

  it("group_read_messages pages by persisted sequence, max 50, within the estimated 8k cap", async () => {
    const { group, alpha } = squad();
    const a = { sessionId: alpha, groupId: group.id };
    expect(runGroupTool("group_read_messages", a, {})).toBe("No messages.");
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      ids.push(
        appendGroupMessage({
          groupId: group.id,
          authorKind: i % 2 ? "agent" : "user",
          ...(i % 2 ? { authorSessionId: alpha } : {}),
          body: `message ${i}`,
          // Pairs share a timestamp; append sequence preserves their conversation order.
          createdAt: at(Math.floor(i / 2)),
        }).id,
      );
    }
    const ordered = ids;
    const idsIn = (text: string) => [...text.matchAll(/^\[(\S+) /gm)].map((m) => m[1]);

    const first = runGroupTool("group_read_messages", a, { limit: 5 });
    expect(idsIn(first)).toEqual(ordered.slice(-5));
    expect(first).toContain("@Alpha: message");
    const before = /before="(\S+)"/.exec(first)?.[1];
    expect(before).toBe(ordered.at(-5));
    const second = runGroupTool("group_read_messages", a, { before: before ?? "", limit: 5 });
    expect(idsIn(second)).toEqual(ordered.slice(-10, -5));

    // Limit is capped at 50.
    const big = runGroupTool("group_read_messages", a, { limit: 500 });
    expect(idsIn(big)).toHaveLength(GROUP_READ_MESSAGES_MAX_LIMIT);
    // Walking back reaches the start without skips or duplicates.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = runGroupTool("group_read_messages", a, {
        limit: 7,
        ...(cursor ? { before: cursor } : {}),
      });
      seen.unshift(...(idsIn(page) as string[]));
      cursor = /before="(\S+)"/.exec(page)?.[1];
      if (!cursor) {
        expect(page).toContain("(no older messages)");
        break;
      }
    }
    expect(seen).toEqual(ordered);
    expect(runGroupTool("group_read_messages", a, { before: "missing" })).toMatch(
      /^\[group-error:message-not-found\] /,
    );
  });

  it("group_read_messages stops at the estimated token cap and points to older messages", async () => {
    const { group, alpha } = squad();
    const a = { sessionId: alpha, groupId: group.id };
    for (let i = 0; i < 10; i += 1) {
      appendGroupMessage({ groupId: group.id, authorKind: "user", body: "x".repeat(6_000) });
    }
    const page = runGroupTool("group_read_messages", a, { limit: 10 });
    expect(estimateGroupTokens(page)).toBeLessThanOrEqual(GROUP_READ_MESSAGES_MAX_TOKENS + 50);
    expect([...page.matchAll(/^\[/gm)].length).toBe(5);
    expect(page).toMatch(/older messages: call group_read_messages with before="/);
  });

  it("a non-member calling execute directly gets not-a-member and changes nothing", async () => {
    const { ws, group, alpha, loner } = squad();
    registerGroupTools();
    const byName = new Map(
      toolRegistry
        .getCustomToolDefinitions("chat")
        .map((definition) => [definition.name, definition]),
    );
    const call = async (name: string, params: unknown) => {
      const execute = byName.get(name)?.execute as unknown as (
        id: string,
        params: unknown,
        signal: undefined,
        onUpdate: undefined,
        ctx: { cwd: string },
      ) => Promise<{ content: Array<{ text: string }> }>;
      return (await execute("call", params, undefined, undefined, { cwd: "/tmp" })).content[0]
        ?.text;
    };
    // Room and task state the loner could try to touch.
    appendGroupMessage({ groupId: group.id, authorKind: "user", body: "hello" });
    const id = taskIdFrom(
      runGroupTool("group_create_task", { sessionId: alpha, groupId: group.id }, { title: "T" }),
    );
    const tasksBefore = listGroupTasks(group.id);
    const messagesBefore = listGroupMessages(group.id);
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });

    // The loner even claims the group's id: membership is re-checked from the store.
    for (const context of [
      { workspaceId: ws, cwd: "/tmp", sessionId: loner },
      { workspaceId: ws, cwd: "/tmp", sessionId: loner, groupId: group.id },
    ]) {
      setAgentToolContext(context);
      for (const [name, params] of [
        ["group_read_messages", {}],
        ["group_list_tasks", {}],
        ["group_create_task", { title: "Sneaky" }],
        ["group_claim_task", { id }],
        ["group_release_task", { id }],
        ["group_request_review", { id, reviewer: "Beta" }],
        ["group_review_task", { id, verdict: "approve" }],
        ["group_start_worktree", {}],
        ["group_record_decision", { text: "Sneaky decision" }],
        ["group_assign_task", { taskId: id, memberId: "Beta" }],
        ["group_propose_agreement", { summary: "Ship it" }],
        ["group_agree", { note: "ok" }],
        ["group_block", { reason: "gap" }],
        ["group_handoff", { memberId: "Beta", objective: "do it" }],
      ] as const) {
        expect(await call(name, params)).toMatch(/^\[group-error:not-a-member\] /);
      }
    }
    expect(listGroupTasks(group.id)).toEqual(tasksBefore);
    expect(listGroupMessages(group.id)).toEqual(messagesBefore);
    expect(listGroupDecisions(group.id)).toEqual([]);
    expect(wakes).toEqual([]);
  });

  it("registers PI definitions that read the owning session's groupId from the tool context", async () => {
    const { ws, group, alpha, loner } = squad();
    registerGroupTools();
    const definitions = toolRegistry
      .getCustomToolDefinitions("chat")
      .filter((definition) => (GROUP_TOOL_NAMES as readonly string[]).includes(definition.name));
    expect(definitions.map((definition) => definition.name).sort()).toEqual(
      [...GROUP_TOOL_NAMES].sort(),
    );
    const list = definitions.find((definition) => definition.name === "group_list_tasks");
    const execute = list?.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: { cwd: string },
    ) => Promise<{ content: Array<{ text: string }> }>;
    setAgentToolContext({ workspaceId: ws, cwd: "/tmp", sessionId: alpha, groupId: group.id });
    expect(
      (await execute("call-1", {}, undefined, undefined, { cwd: "/tmp" })).content[0]?.text,
    ).toBe("No tasks.");
    setAgentToolContext({ workspaceId: ws, cwd: "/tmp", sessionId: loner });
    expect(
      (await execute("call-2", {}, undefined, undefined, { cwd: "/tmp" })).content[0]?.text,
    ).toMatch(/^\[group-error:not-a-member\] /);
  });
});

describe("group_record_decision", () => {
  it("records a trimmed decision and posts 'Decision: <text>' as the member without waking anyone", async () => {
    const { group, alpha } = squad();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const text = runGroupTool(
      "group_record_decision",
      { sessionId: alpha, groupId: group.id },
      { text: "  Use SQLite with WAL  " },
    );
    const [decision] = listGroupDecisions(group.id);
    expect(decision).toMatchObject({ text: "Use SQLite with WAL", authorSessionId: alpha });
    expect(text).toBe(`Recorded decision ${decision?.id}: Use SQLite with WAL`);
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: alpha,
        body: "Decision: Use SQLite with WAL",
        wake: false,
      },
    ]);
  });

  it("returns invalid-text for empty or over-500-character text and records nothing", async () => {
    const { group, alpha } = squad();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const caller = { sessionId: alpha, groupId: group.id };
    for (const text of ["", "   \n ", "x".repeat(501)]) {
      expect(runGroupTool("group_record_decision", caller, { text })).toMatch(
        /^\[group-error:invalid-text\] /,
      );
    }
    expect(runGroupTool("group_record_decision", caller, { text: ` ${"y".repeat(500)} ` })).toMatch(
      /^Recorded decision /,
    );
    expect(listGroupDecisions(group.id)).toHaveLength(1);
    expect(wakes).toHaveLength(1);
  });

  it(`returns limit-reached past ${GROUP_DECISION_LIMIT} decisions per group`, async () => {
    const { group, alpha, beta } = squad();
    for (let index = 0; index < GROUP_DECISION_LIMIT; index += 1) {
      runGroupTool(
        "group_record_decision",
        { sessionId: index % 2 ? alpha : beta, groupId: group.id },
        { text: `D${index}` },
      );
    }
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    expect(
      runGroupTool("group_record_decision", { sessionId: alpha, groupId: group.id }, { text: "x" }),
    ).toMatch(/^\[group-error:limit-reached\] /);
    expect(listGroupDecisions(group.id)).toHaveLength(GROUP_DECISION_LIMIT);
    expect(wakes).toEqual([]);
  });

  it("refuses a member of another group (not-a-member) and a caller that left", async () => {
    const { group, alpha } = squad();
    const other = squad();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    expect(
      runGroupTool(
        "group_record_decision",
        { sessionId: other.alpha, groupId: group.id },
        { text: "x" },
      ),
    ).toMatch(/^\[group-error:not-a-member\] /);
    removeAgentGroupMember(group.id, alpha);
    expect(
      runGroupTool("group_record_decision", { sessionId: alpha, groupId: group.id }, { text: "x" }),
    ).toMatch(/^\[group-error:not-a-member\] /);
    expect(listGroupDecisions(group.id)).toEqual([]);
    expect(wakes).toEqual([]);
  });
});

describe("group_assign_task (coordinator mode)", () => {
  /** Squad with Alpha as Lead and coordinator mode on. */
  function coordinated() {
    const fixture = squad();
    setAgentGroupMode(fixture.group.id, "coordinator");
    const lead = { sessionId: fixture.alpha, groupId: fixture.group.id };
    const create = (title: string) =>
      taskIdFrom(runGroupTool("group_create_task", lead, { title }));
    return { ...fixture, lead, create };
  }

  it("assigns an open task: in_progress, posts Assigned and wakes the member (with the note)", async () => {
    const { group, alpha, beta, lead, create } = coordinated();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const id = create("Parser");
    const text = runGroupTool("group_assign_task", lead, {
      taskId: id,
      memberId: "@Beta",
      note: " start with the lexer ",
    });
    expect(text).toMatch(/^Assigned task \S+ \[in_progress\] "Parser" owner=@Beta/);
    expect(listGroupTasks(group.id)[0]).toMatchObject({
      status: "in_progress",
      ownerSessionId: beta,
    });
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: alpha,
        targetSessionId: beta,
        body: `Assigned: "Parser" (task ${id}) → @Beta: start with the lexer`,
      },
    ]);
  });

  it("refuses an archived assignee (member-archived) and a group without a folder", async () => {
    const { group, beta, lead, create } = coordinated();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const id = create("Parser");
    const agentId = getDatabase()
      .prepare("select agent_id from agent_group_members where session_id = ?")
      .get(beta) as { agent_id: string };
    setAgentArchived(agentId.agent_id, true);
    try {
      expect(runGroupTool("group_assign_task", lead, { taskId: id, memberId: "@Beta" })).toMatch(
        /^\[group-error:member-archived\] /,
      );
    } finally {
      setAgentArchived(agentId.agent_id, false);
    }
    for (const workspaceId of [null, "modus-inbox-chats"]) {
      getDatabase()
        .prepare("update agent_groups set workspace_id = ? where id = ?")
        .run(workspaceId, group.id);
      expect(runGroupTool("group_assign_task", lead, { taskId: id, memberId: "@Beta" })).toMatch(
        /^\[group-error:group-project-required\] /,
      );
    }
    expect(wakes).toEqual([]);
    expect(listGroupTasks(group.id)[0]?.status).toBe("open");
  });

  it("reassigns an in_progress task: Reassigned old → new, wakes only the new owner", async () => {
    const { group, alpha, beta, lead, create } = coordinated();
    const gamma = insertSession(insertWorkspace(), "Gamma");
    const id = create("Parser");
    runGroupTool("group_claim_task", { sessionId: beta, groupId: group.id }, { id });
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    // Gamma is not a member yet.
    expect(runGroupTool("group_assign_task", lead, { taskId: id, memberId: gamma })).toMatch(
      /^\[group-error:not-a-member\] /,
    );
    const text = runGroupTool("group_assign_task", lead, { taskId: id, memberId: alpha });
    expect(text).toMatch(/^Reassigned task \S+ \[in_progress\] "Parser" owner=@Alpha/);
    // The Lead took it itself: the line posts, nobody is woken.
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: alpha,
        targetSessionId: alpha,
        body: `Reassigned: "Parser" (task ${id}): @Beta → @Alpha`,
        wake: false,
      },
    ]);
    runGroupTool("group_assign_task", lead, { taskId: id, memberId: "Beta" });
    // No branch on the task: no suffix.
    expect(wakes.at(-1)).toEqual({
      groupId: group.id,
      actorSessionId: alpha,
      targetSessionId: beta,
      body: `Reassigned: "Parser" (task ${id}): @Alpha → @Beta`,
    });
  });

  it("returns not-coordinator, coordinator-off and invalid-transition as text, waking nobody", async () => {
    const { group, beta, lead, create } = coordinated();
    const id = create("Parser");
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    expect(
      runGroupTool(
        "group_assign_task",
        { sessionId: beta, groupId: group.id },
        { taskId: id, memberId: "Alpha" },
      ),
    ).toMatch(/^\[group-error:not-coordinator\] /);
    runGroupTool("group_assign_task", lead, { taskId: id, memberId: "Beta" });
    wakes.length = 0;
    // Beta already owns it.
    expect(runGroupTool("group_assign_task", lead, { taskId: id, memberId: "Beta" })).toMatch(
      /^\[group-error:invalid-transition\] /,
    );
    setAgentGroupLead(group.id, null);
    expect(runGroupTool("group_assign_task", lead, { taskId: id, memberId: "Beta" })).toMatch(
      /^\[group-error:coordinator-off\] /,
    );
    setAgentGroupLead(group.id, lead.sessionId);
    setAgentGroupMode(group.id, "free");
    expect(runGroupTool("group_assign_task", lead, { taskId: id, memberId: "Beta" })).toMatch(
      /^\[group-error:coordinator-off\] /,
    );
    expect(wakes).toEqual([]);
  });
});

describe("agreement tools (P1b)", () => {
  it("hands off by session ID when the target's display name contains spaces", async () => {
    const ws = insertWorkspace();
    const alpha = insertSession(ws, "Alpha");
    const jennie = insertSession(ws, "Jennie 2");
    const group = createAgentGroupWithMembers({
      name: "Spaced names",
      workspaceId: ws,
      members: [{ sessionId: alpha }, { sessionId: jennie }],
      leadSessionId: alpha,
    });
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const text = runGroupTool(
      "group_handoff",
      { sessionId: alpha, groupId: group.id },
      {
        memberId: jennie,
        objective: "revisar os testes",
      },
    );
    expect(text).toBe("Handed off to @Jennie 2: revisar os testes.");
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: alpha,
        targetSessionId: jennie,
        body: "Handoff → @Jennie 2 · revisar os testes",
      },
    ]);
    expect(parseGroupCollabStatusLine((wakes[0] as { body: string }).body)).toEqual({
      kind: "handoff",
      targetName: "Jennie 2",
      objective: "revisar os testes",
    });
  });

  it("posts a self handoff without waking the same agent again", async () => {
    const { group, alpha } = squad();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    runGroupTool(
      "group_handoff",
      { sessionId: alpha, groupId: group.id },
      {
        memberId: alpha,
        objective: "document the result",
      },
    );
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: alpha,
        targetSessionId: alpha,
        body: "Handoff → @Alpha · document the result",
        wake: false,
      },
    ]);
  });

  it("group_handoff posts typed status, wakes the target, and optionally creates a task", async () => {
    const { group, alpha, beta } = squad();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const text = runGroupTool(
      "group_handoff",
      { sessionId: alpha, groupId: group.id },
      { memberId: "@Beta", objective: "toggle + tests", taskTitle: "Dark mode" },
    );
    expect(text).toMatch(
      /^Handed off to @Beta: toggle \+ tests\. Created task \S+ \[in_progress\]/,
    );
    const id = taskIdFrom(text);
    expect(listGroupTasks(group.id)[0]).toMatchObject({
      id,
      title: "Dark mode",
      description: "toggle + tests",
      status: "in_progress",
      ownerSessionId: beta,
    });
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: alpha,
        targetSessionId: beta,
        body: "Handoff → @Beta · toggle + tests",
      },
    ]);
  });

  it("group_propose_agreement posts Proposed and can request review from confirmer", async () => {
    const { group, alpha, beta } = squad();
    const a = { sessionId: alpha, groupId: group.id };
    const id = taskIdFrom(runGroupTool("group_create_task", a, { title: "Ship" }));
    runGroupTool("group_claim_task", a, { id });
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const text = runGroupTool("group_propose_agreement", a, {
      summary: "dark mode ready",
      taskId: id,
      confirmer: "Beta",
    });
    expect(text).toMatch(/^Proposed agreement: dark mode ready\. Task task \S+ \[in_review\]/);
    expect(listGroupTasks(group.id)[0]).toMatchObject({
      status: "in_review",
      reviewerSessionId: beta,
    });
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: alpha,
        targetSessionId: beta,
        body: "Proposed · dark mode ready",
      },
    ]);
  });

  it("group_agree closes the task, records a decision, and posts Agreed without waking", async () => {
    const { group, alpha, beta } = squad();
    const a = { sessionId: alpha, groupId: group.id };
    const id = taskIdFrom(runGroupTool("group_create_task", a, { title: "Ship" }));
    runGroupTool("group_claim_task", a, { id });
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const text = await runGroupVerifiedTool(
      "group_agree",
      { sessionId: beta, groupId: group.id },
      { note: "looks good", taskId: id, decision: "Ship dark mode" },
    );
    expect(text).toMatch(/^Agreed\. Closed task \S+ \[done\] "Ship"/);
    expect(text).toMatch(/Recorded decision \S+: Ship dark mode$/);
    expect(listGroupTasks(group.id)[0]?.status).toBe("done");
    expect(listGroupDecisions(group.id)).toEqual([
      expect.objectContaining({ text: "Ship dark mode", authorSessionId: beta }),
    ]);
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: beta,
        body: "Agreed · looks good",
        wake: false,
      },
    ]);
  });

  it("group_block posts Blocked and wakes returnTo when set", async () => {
    const { group, alpha, beta } = squad();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const text = runGroupTool(
      "group_block",
      { sessionId: beta, groupId: group.id },
      { reason: "missing tests", returnTo: "Alpha" },
    );
    expect(text).toBe("Blocked: missing tests");
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: beta,
        targetSessionId: alpha,
        body: "Blocked · missing tests",
      },
    ]);
  });

  it("group_block returns to itself without scheduling another turn", async () => {
    const { group, alpha } = squad();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    runGroupTool(
      "group_block",
      { sessionId: alpha, groupId: group.id },
      {
        reason: "waiting for user input",
        returnTo: alpha,
      },
    );
    expect(wakes).toEqual([
      {
        groupId: group.id,
        actorSessionId: alpha,
        targetSessionId: alpha,
        body: "Blocked · waiting for user input",
        wake: false,
      },
    ]);
  });

  it("group_block rejects a task from another group before publishing or waking", async () => {
    const { group, alpha, beta } = squad();
    const other = squad();
    const taskId = taskIdFrom(
      runGroupTool(
        "group_create_task",
        {
          sessionId: other.alpha,
          groupId: other.group.id,
        },
        { title: "Private task" },
      ),
    );
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    expect(
      runGroupTool(
        "group_block",
        { sessionId: alpha, groupId: group.id },
        {
          reason: "need more context",
          taskId,
          returnTo: beta,
        },
      ),
    ).toMatch(/^\[group-error:invalid-value\] /);
    expect(wakes).toEqual([]);
  });

  it("refuses empty propose/block/handoff inputs and unknown tasks", async () => {
    const { group, alpha } = squad();
    const caller = { sessionId: alpha, groupId: group.id };
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    expect(runGroupTool("group_propose_agreement", caller, { summary: "  " })).toMatch(
      /^\[group-error:invalid-value\] /,
    );
    expect(runGroupTool("group_block", caller, { reason: "" })).toMatch(
      /^\[group-error:invalid-value\] /,
    );
    expect(runGroupTool("group_handoff", caller, { memberId: "Beta", objective: "   " })).toMatch(
      /^\[group-error:invalid-value\] /,
    );
    expect(
      runGroupTool("group_propose_agreement", caller, {
        summary: "x",
        taskId: "missing-task",
      }),
    ).toMatch(/^\[group-error:invalid-value\] /);
    expect(wakes).toEqual([]);
  });
});

describe("consistent group task operations", () => {
  it("handoff_title_assigns_before_wake", async () => {
    const { group, alpha, beta } = squad();
    const observed: unknown[] = [];
    setGroupTaskWakeSink((wake) => {
      observed.push({ wake, task: listGroupTasks(group.id)[0] });
      return { id: "test-delivery" };
    });
    const result = runGroupTool(
      "group_handoff",
      { sessionId: alpha },
      {
        memberId: beta,
        objective: "Implement",
        taskTitle: "Atomic handoff",
        operationId: "handoff-before-wake",
      },
    );
    expect(result).toContain("[in_progress]");
    expect(observed).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ ownerSessionId: beta, status: "in_progress" }),
        wake: expect.objectContaining({
          operationId: "handoff-before-wake",
          sourceEventId: expect.any(String),
        }),
      }),
    ]);
    const before = listGroupTasks(group.id).length;
    getDatabase().exec(`create trigger reject_handoff_assignment before update of owner_session_id on group_tasks
      when new.title = 'Reject assignment' begin select raise(abort, 'assignment rejected'); end`);
    try {
      expect(
        runGroupTool(
          "group_handoff",
          { sessionId: alpha },
          {
            memberId: beta,
            objective: "Fail",
            taskTitle: "Reject assignment",
            operationId: "handoff-rollback",
          },
        ),
      ).toContain("assignment rejected");
      expect(listGroupTasks(group.id)).toHaveLength(before);
      expect(observed).toHaveLength(1);
    } finally {
      getDatabase().exec("drop trigger reject_handoff_assignment");
    }
  });

  it("handoff_retry_returns_same_task_and_wake", async () => {
    const { group, alpha, beta } = squad();
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const caller = { sessionId: alpha, runId: "retry-run", toolCallId: "retry-call" };
    const input = { memberId: beta, objective: "Implement", taskTitle: "Retry task" };
    const first = runGroupTool("group_handoff", caller, input);
    const retry = runGroupTool("group_handoff", caller, input);
    expect(retry).toBe(first);
    expect(listGroupTasks(group.id)).toHaveLength(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      operationId: expect.stringContaining("retry-run"),
      taskId: taskIdFrom(first),
    });
    const events = taskStore.listGroupTaskTransitions(taskIdFrom(first));
    expect(events).toHaveLength(1);
  });

  it("agree_cannot_bypass_required_qa", async () => {
    const { group, alpha, beta } = squad();
    const task = taskStore.createGroupTask({
      groupId: group.id,
      title: "QA required",
      ownerSessionId: alpha,
      reviewerSessionId: beta,
      status: "in_review",
      kind: "code",
      priority: "normal",
      dependencyIds: [],
      criteria: [{ id: "tests", description: "Tests pass", requiredCheckKinds: ["tests"] }],
      verificationPolicy: { mode: "required", requireReview: true },
    });
    const result = await runGroupVerifiedTool(
      "group_agree",
      { sessionId: beta },
      {
        taskId: task.id,
        expectedVersion: 1,
        operationId: "agree-without-qa",
        decision: "Ready when QA passes",
      },
    );
    expect(result).toContain("verification-required");
    expect(taskStore.getGroupTask(task.id)).toMatchObject({ status: "in_review", stateVersion: 1 });
    expect(listGroupDecisions(group.id)).toEqual([
      expect.objectContaining({ text: "Ready when QA passes" }),
    ]);
  });

  it("block_persists_task_status", async () => {
    const { group, alpha } = squad();
    const caller = { sessionId: alpha };
    const task = taskStore.createGroupTask({
      groupId: group.id,
      title: "Block me",
      ownerSessionId: alpha,
      status: "in_progress",
    });
    const other = taskStore.createGroupTask({ groupId: group.id, title: "Untouched" });
    const input = {
      taskId: task.id,
      reason: "Need credentials",
      expectedVersion: 1,
      operationId: "block-selected",
    };
    const first = runGroupTool("group_block", caller, input);
    expect(taskStore.getGroupTask(task.id)).toMatchObject({
      status: "blocked",
      blockedReason: "Need credentials",
      stateVersion: 2,
    });
    expect(runGroupTool("group_block", caller, input)).toBe(first);
    expect(
      runGroupTool("group_report_progress", caller, {
        taskId: task.id,
        expectedVersion: 1,
        operationId: "stale-progress",
        stage: "verify",
      }),
    ).toContain("stale-task");
    expect(taskStore.getGroupTask(other.id).status).toBe("open");
    expect(
      runGroupTool("group_report_progress", caller, {
        taskId: task.id,
        expectedVersion: 2,
        operationId: "clear-block",
        blockedReason: null,
      }),
    ).toContain("[in_progress]");
  });

  it("explicit_review_dispatches_in_suggest_mode", async () => {
    const { group, alpha, beta } = squad();
    const task = taskStore.createGroupTask({
      groupId: group.id,
      title: "Review",
      ownerSessionId: alpha,
      status: "in_progress",
    });
    setGroupTaskWakeSink((wake) => {
      wakes.push(wake);
      return { id: "test-delivery" };
    });
    const input = {
      id: task.id,
      reviewer: beta,
      expectedVersion: 1,
      operationId: "explicit-review",
    };
    const first = runGroupTool("group_request_review", { sessionId: alpha }, input);
    expect(runGroupTool("group_request_review", { sessionId: alpha }, input)).toBe(first);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      targetSessionId: beta,
      taskId: task.id,
      operationId: "explicit-review",
      sourceEventId: expect.any(String),
    });
    const reviewInput = {
      id: task.id,
      verdict: "approve" as const,
      expectedVersion: 2,
      operationId: "approve-review",
      approvedCriterionIds: [],
    };
    const verify = vi.spyOn(taskEvidence, "verifyGroupTaskForTransition");
    expect(
      await runGroupVerifiedTool("group_review_task", { sessionId: beta }, reviewInput),
    ).toContain("[done]");
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, expectedVersion: 2, action: "approve" }),
    );
    expect(taskStore.getGroupTask(task.id)).toMatchObject({
      status: "done",
      stateVersion: 3,
      review: { reviewerSessionId: beta, verdict: "approve", sourceFingerprint: "current-source" },
    });
    expect(
      await runGroupVerifiedTool("group_review_task", { sessionId: beta }, reviewInput),
    ).toContain("[done]");
    expect(wakes).toHaveLength(2);
    verify.mockRestore();
  });
});

it("persists changes review and task status atomically", async () => {
  const { group, alpha, beta } = squad();
  const task = taskStore.createGroupTask({
    groupId: group.id,
    title: "Changes",
    ownerSessionId: alpha,
    reviewerSessionId: beta,
    status: "in_review",
  });
  expect(
    await runGroupVerifiedTool(
      "group_review_task",
      { sessionId: beta },
      { id: task.id, verdict: "changes", expectedVersion: 1, operationId: "typed-changes-review" },
    ),
  ).toContain("[in_progress]");
  expect(taskStore.getGroupTask(task.id)).toMatchObject({
    status: "in_progress",
    review: { verdict: "changes", reviewerSessionId: beta, criteriaVersion: 1 },
  });
});

it("requires explicit approval of criteria without declared QA checks", async () => {
  const { group, alpha, beta } = squad();
  const task = taskStore.createGroupTask({
    groupId: group.id,
    title: "Documentation",
    ownerSessionId: alpha,
    reviewerSessionId: beta,
    status: "in_review",
    kind: "docs",
    priority: "normal",
    dependencyIds: [],
    criteria: [{ id: "readable", description: "Clear prose", requiredCheckKinds: [] }],
    verificationPolicy: { mode: "required", requireReview: true },
  });
  expect(
    await runGroupVerifiedTool(
      "group_review_task",
      { sessionId: beta },
      {
        id: task.id,
        verdict: "approve",
        expectedVersion: 1,
        operationId: "missing-criterion-approval",
      },
    ),
  ).toContain("verification-required");
  expect(taskStore.getGroupTask(task.id)).toMatchObject({ status: "in_review", stateVersion: 1 });
  expect(taskStore.getGroupTask(task.id).review).toBeUndefined();
  expect(
    await runGroupVerifiedTool(
      "group_review_task",
      { sessionId: beta },
      {
        id: task.id,
        verdict: "approve",
        expectedVersion: 1,
        operationId: "explicit-criterion-approval",
        approvedCriterionIds: ["readable"],
      },
    ),
  ).toContain("[done]");
});

it("rejects a concurrent task write during async verification", async () => {
  const { group, alpha, beta } = squad();
  const task = taskStore.createGroupTask({
    groupId: group.id,
    title: "Concurrent",
    ownerSessionId: alpha,
    reviewerSessionId: beta,
    status: "in_review",
  });
  const original = taskEvidence.verifyGroupTaskForTransition;
  const spy = vi
    .spyOn(taskEvidence, "verifyGroupTaskForTransition")
    .mockImplementationOnce(async (input) => {
      const snapshot = await original(input);
      expect(snapshot).toMatchObject({
        task: { id: task.id, stateVersion: 1 },
        sourceFingerprint: "current-source",
        criterionOutcomes: [],
        dependencies: [],
      });
      taskStore.reportGroupTaskProgress({
        groupId: group.id,
        taskId: task.id,
        actorSessionId: beta,
        stage: "review",
        expectedVersion: 1,
        operationId: "concurrent-progress",
      });
      return snapshot;
    });
  try {
    expect(
      await runGroupVerifiedTool(
        "group_review_task",
        { sessionId: beta },
        { id: task.id, verdict: "approve", expectedVersion: 1, operationId: "stale-async-review" },
      ),
    ).toContain("stale-task");
    expect(taskStore.getGroupTask(task.id)).toMatchObject({ status: "in_review", stateVersion: 2 });
    expect(taskStore.getGroupTask(task.id).review).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

it("rolls back proposed review when the status write fails", async () => {
  const { group, alpha, beta } = squad();
  const task = taskStore.createGroupTask({
    groupId: group.id,
    title: "Reject completion",
    ownerSessionId: alpha,
    reviewerSessionId: beta,
    status: "in_review",
  });
  getDatabase().exec(
    `create trigger reject_review_status before update of status on group_tasks when new.title = 'Reject completion' and new.status = 'done' begin select raise(abort, 'completion rejected'); end`,
  );
  try {
    expect(
      await runGroupVerifiedTool(
        "group_review_task",
        { sessionId: beta },
        { id: task.id, verdict: "approve", expectedVersion: 1, operationId: "rollback-review" },
      ),
    ).toContain("completion rejected");
    expect(taskStore.getGroupTask(task.id)).toMatchObject({ status: "in_review", stateVersion: 1 });
    expect(taskStore.getGroupTask(task.id).review).toBeUndefined();
    expect(taskStore.listGroupTaskTransitions(task.id)).toEqual([]);
  } finally {
    getDatabase().exec("drop trigger reject_review_status");
  }
});

it("creates a typed task directly from its draft", () => {
  const { group, alpha } = squad();
  const draft = {
    title: "Draft title",
    kind: "research" as const,
    priority: "high" as const,
    dependencyIds: [],
    criteria: [],
    verificationPolicy: { mode: "none" as const, requireReview: false },
  };
  expect(
    runGroupTool(
      "group_create_task",
      { sessionId: alpha },
      { draft, operationId: "draft-only-task" },
    ),
  ).toContain("Draft title");
  expect(listGroupTasks(group.id)[0]).toMatchObject({ kind: "research", priority: "high" });
});

it("retries wake delivery after a failing sink using the same source event", () => {
  const { group, alpha, beta } = squad();
  const attempts: unknown[] = [];
  setGroupTaskWakeSink((wake) => {
    attempts.push(wake);
    if (attempts.length === 1) throw new Error("wake delivery failed");
    return { id: "test-delivery" };
  });
  const input = {
    memberId: beta,
    objective: "Deliver",
    taskTitle: "Retry failed wake",
    operationId: "retry-failed-dispatch",
  };
  expect(runGroupTool("group_handoff", { sessionId: alpha }, input)).toContain(
    "wake delivery failed",
  );
  expect(runGroupTool("group_handoff", { sessionId: alpha }, input)).toContain("[in_progress]");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(runGroupTool("group_handoff", { sessionId: alpha }, input)).toContain("[in_progress]");
  expect(attempts).toHaveLength(2);
  expect(listGroupTasks(group.id)).toHaveLength(1);
});

it("validates block return target before writing task state", () => {
  const { group, alpha } = squad();
  const task = taskStore.createGroupTask({
    groupId: group.id,
    title: "Unchanged block",
    ownerSessionId: alpha,
    status: "in_progress",
  });
  expect(
    runGroupTool(
      "group_block",
      { sessionId: alpha },
      {
        taskId: task.id,
        reason: "Need help",
        returnTo: "unknown-member",
        expectedVersion: 1,
        operationId: "invalid-block-target",
      },
    ),
  ).toContain("not-a-member");
  expect(taskStore.getGroupTask(task.id)).toMatchObject({ status: "in_progress", stateVersion: 1 });
  expect(taskStore.listGroupTaskTransitions(task.id)).toEqual([]);
});

it("changes review returns work without requiring unavailable QA", async () => {
  const { group, alpha, beta } = squad();
  const task = taskStore.createGroupTask({
    groupId: group.id,
    title: "Missing QA changes",
    ownerSessionId: alpha,
    reviewerSessionId: beta,
    status: "in_review",
    kind: "code",
    priority: "normal",
    dependencyIds: [],
    criteria: [{ id: "tests", description: "Tests pass", requiredCheckKinds: ["tests"] }],
    verificationPolicy: { mode: "required", requireReview: true },
  });
  expect(
    await runGroupVerifiedTool(
      "group_review_task",
      { sessionId: beta },
      { id: task.id, verdict: "changes", expectedVersion: 1, operationId: "changes-without-qa" },
    ),
  ).toContain("[in_progress]");
  expect(taskStore.getGroupTask(task.id)).toMatchObject({
    status: "in_progress",
    stateVersion: 2,
    review: { verdict: "changes", reviewerSessionId: beta },
  });
});

it("taskless agreement retries return the same decision and status delivery", async () => {
  const { group, alpha } = squad();
  setGroupTaskWakeSink((wake) => {
    wakes.push(wake);
    return { id: "test-delivery" };
  });
  const caller = { sessionId: alpha, runId: "taskless-run", toolCallId: "taskless-call" };
  const input = { note: "Agreed together", operationId: "taskless-agreement" };
  const first = await runGroupVerifiedTool("group_agree", caller, input);
  expect(await runGroupVerifiedTool("group_agree", caller, input)).toBe(first);
  expect(listGroupDecisions(group.id)).toHaveLength(1);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({
    operationId: "taskless-agreement",
    sourceEventId: listGroupDecisions(group.id)[0]?.id,
  });
  expect(
    await runGroupVerifiedTool("group_agree", caller, { ...input, note: "Different request" }),
  ).toContain("invalid-value");
  expect(listGroupDecisions(group.id)).toHaveLength(1);
  expect(wakes).toHaveLength(1);
});

it("taskless handoff retries preserve operation identity and reject conflicting reuse", () => {
  const { group, alpha, beta } = squad();
  setGroupTaskWakeSink((wake) => {
    wakes.push(wake);
    return { id: "delivered-taskless" };
  });
  const input = {
    memberId: beta,
    objective: "Delegate without a task",
    operationId: "taskless-handoff",
  };
  const first = runGroupTool("group_handoff", { sessionId: alpha }, input);
  expect(runGroupTool("group_handoff", { sessionId: alpha }, input)).toBe(first);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({
    operationId: input.operationId,
    sourceEventId: expect.any(String),
  });
  expect(
    runGroupTool(
      "group_handoff",
      { sessionId: alpha },
      { ...input, objective: "Different objective" },
    ),
  ).toContain("invalid-value");
  expect(wakes).toHaveLength(1);
  expect(listGroupTasks(group.id)).toHaveLength(0);
});

it("keeps successful sink delivery without a runtime receipt suppressed on retry", () => {
  const { alpha, beta } = squad();
  const delivered: unknown[] = [];
  setGroupTaskWakeSink((wake) => {
    delivered.push(wake);
    return { id: "fake-persisted-message" };
  });
  const operationId = "fake-delivery-without-receipt";
  const invoke = () =>
    runGroupTool(
      "group_handoff",
      { sessionId: alpha },
      {
        memberId: beta,
        objective: "Fake delivery ack",
        taskTitle: "Fake acknowledgement",
        operationId,
      },
    );
  const first = invoke();
  expect(
    getDatabase()
      .prepare("select 1 from group_task_dispatches where operation_id = ?")
      .get(operationId),
  ).toBeUndefined();
  expect(invoke()).toBe(first);
  expect(delivered).toHaveLength(1);
});
