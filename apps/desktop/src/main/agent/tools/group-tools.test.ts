import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../../db/database");
const { ensureChatsWorkspace } = await import("../../workspace/workspace-store");
const {
  appendGroupMessage,
  createAgentGroupWithMembers,
  GROUP_DECISION_LIMIT,
  listGroupDecisions,
  listGroupMessages,
  listGroupTasks,
  removeAgentGroupMember,
} = await import("../../groups/group-store");
const {
  GROUP_READ_MESSAGES_MAX_LIMIT,
  GROUP_READ_MESSAGES_MAX_TOKENS,
  GROUP_TOOL_NAMES,
  registerGroupTools,
  runGroupTool,
  setGroupTaskWakeSink,
} = await import("./group-tools");
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
  it("run the task flow through the store and route review / changes wakes", () => {
    const { group, alpha, beta } = squad();
    setGroupTaskWakeSink((wake) => wakes.push(wake));
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
      runGroupTool("group_review_task", b, { id, verdict: "changes", note: "add tests" }),
    ).toContain("Changes requested: task");
    expect(wakes.at(-1)).toEqual({
      groupId: group.id,
      actorSessionId: beta,
      targetSessionId: alpha,
      body: `Changes requested on "Parser" (task ${id}) @Alpha: add tests`,
    });

    runGroupTool("group_request_review", a, { id, reviewer: beta });
    expect(runGroupTool("group_review_task", b, { id, verdict: "approve" })).toContain(
      "Approved: task",
    );
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

  it("approve with a note records the note in the status", () => {
    const { group, alpha, beta } = squad();
    setGroupTaskWakeSink((wake) => wakes.push(wake));
    const a = { sessionId: alpha, groupId: group.id };
    const b = { sessionId: beta, groupId: group.id };
    const id = taskIdFrom(runGroupTool("group_create_task", a, { title: "T" }));
    runGroupTool("group_claim_task", a, { id });
    runGroupTool("group_request_review", a, { id, reviewer: "Beta" });
    runGroupTool("group_review_task", b, { id, verdict: "approve", note: "  looks good " });
    expect(wakes.at(-1)).toMatchObject({ body: "Approved: looks good", wake: false });
  });

  it("the suggested reviewer may claim; the claim clears the reviewer; self-review still applies", () => {
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

  it("an ambiguous reviewer title returns ambiguous-member with the matching session ids", () => {
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
    const created = runGroupTool("group_create_task", caller, { title: "T", reviewer: "@Twin" });
    expect(created).toMatch(/^\[group-error:ambiguous-member\] /);
    expect(created).toContain(twinA);
    expect(created).toContain(twinB);
    expect(listGroupTasks(group.id)).toEqual([]);

    const id = taskIdFrom(runGroupTool("group_create_task", caller, { title: "T" }));
    runGroupTool("group_claim_task", caller, { id });
    const review = runGroupTool("group_request_review", caller, { id, reviewer: "TWIN" });
    expect(review).toMatch(/^\[group-error:ambiguous-member\] /);
    expect(review).toContain(`${twinA}, ${twinB}`);
    expect(listGroupTasks(group.id)[0]?.status).toBe("in_progress");
    // The retry with a session id works.
    expect(runGroupTool("group_request_review", caller, { id, reviewer: twinB })).toContain(
      "Review requested from @twin",
    );
  });

  it("returns store errors as [group-error:<code>] text and never throws", () => {
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
    expect(runGroupTool("group_review_task", b, { id, verdict: "approve" })).toMatch(
      /^\[group-error:not-reviewer\] /,
    );
    runGroupTool("group_request_review", a, { id, reviewer: "Beta" });
    expect(runGroupTool("group_release_task", a, { id })).toMatch(
      /^\[group-error:invalid-transition\] /,
    );
    expect(runGroupTool("group_claim_task", a, { id: "missing" })).toMatch(
      /^\[group-error:task-not-found\] /,
    );
    expect(runGroupTool("group_review_task", b, { id, verdict: "close" as "approve" })).toMatch(
      /^\[group-error:invalid-value\] /,
    );
    // A caller outside any group, or one that left mid-turn.
    expect(runGroupTool("group_list_tasks", { sessionId: loner }, {})).toMatch(
      /^\[group-error:not-a-member\] /,
    );
    removeAgentGroupMember(group.id, beta);
    expect(runGroupTool("group_list_tasks", b, {})).toMatch(/^\[group-error:not-a-member\] /);
  });

  it("group_read_messages pages by (created_at, id), max 50, within the estimated 8k cap", () => {
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
          // Pairs share a millisecond: the id breaks the tie.
          createdAt: at(Math.floor(i / 2)),
        }).id,
      );
    }
    const ordered = [...ids].sort((x, y) => {
      const i = ids.indexOf(x);
      const j = ids.indexOf(y);
      const tx = at(Math.floor(i / 2));
      const ty = at(Math.floor(j / 2));
      return tx === ty ? (x < y ? -1 : 1) : tx < ty ? -1 : 1;
    });
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

  it("group_read_messages stops at the estimated token cap and points to older messages", () => {
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
    setGroupTaskWakeSink((wake) => wakes.push(wake));

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
  it("records a trimmed decision and posts 'Decision: <text>' as the member without waking anyone", () => {
    const { group, alpha } = squad();
    setGroupTaskWakeSink((wake) => wakes.push(wake));
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

  it("returns invalid-text for empty or over-500-character text and records nothing", () => {
    const { group, alpha } = squad();
    setGroupTaskWakeSink((wake) => wakes.push(wake));
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

  it(`returns limit-reached past ${GROUP_DECISION_LIMIT} decisions per group`, () => {
    const { group, alpha, beta } = squad();
    for (let index = 0; index < GROUP_DECISION_LIMIT; index += 1) {
      runGroupTool(
        "group_record_decision",
        { sessionId: index % 2 ? alpha : beta, groupId: group.id },
        { text: `D${index}` },
      );
    }
    setGroupTaskWakeSink((wake) => wakes.push(wake));
    expect(
      runGroupTool("group_record_decision", { sessionId: alpha, groupId: group.id }, { text: "x" }),
    ).toMatch(/^\[group-error:limit-reached\] /);
    expect(listGroupDecisions(group.id)).toHaveLength(GROUP_DECISION_LIMIT);
    expect(wakes).toEqual([]);
  });

  it("refuses a member of another group (not-a-member) and a caller that left", () => {
    const { group, alpha } = squad();
    const other = squad();
    setGroupTaskWakeSink((wake) => wakes.push(wake));
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
