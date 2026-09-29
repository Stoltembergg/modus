import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../../db/database");
const { ensureChatsWorkspace } = await import("../../workspace/workspace-store");
const {
  createAgentGroupWithMembers,
  createGroupTask,
  deleteAgentGroup,
  listGroupTasks,
  removeAgentGroupMember,
  setAgentGroupLead,
  setAgentGroupMode,
  updateAgentGroupMembers,
} = await import("../../groups/group-store");
const { getAgentSession, setAgentSessionArchived } = await import("../agent-store");
const {
  registerGroupTools,
  runGroupTool,
  setGroupTaskWakeSink,
  setGroupWorktreeReadySink,
  startMemberWorktree: startWorktree,
} = await import("./group-tools");
const { toolRegistry } = await import("./registry");
const { clearAssistantToolCallCount, noteAssistantMessageToolCalls } = await import("./tool-batch");

/** PI's assistant `message_end` for a message with `calls` tool calls (what the runtime records). */
function assistantMessage(sessionId: string, calls: string[]): void {
  noteAssistantMessageToolCalls(sessionId, {
    role: "assistant",
    content: [
      { type: "text", text: "On it." },
      ...calls.map((name, index) => ({
        type: "toolCall",
        id: `call-${index}`,
        name,
        arguments: {},
      })),
    ],
  });
}
const lone = (sessionId: string) => assistantMessage(sessionId, ["group_start_worktree"]);
const { setAgentToolContext } = await import("./tool-context");

/** The tool text (these tests run outside any group turn: no sink, no turn end). */
async function startMemberWorktree(caller: { sessionId: string; groupId?: string }) {
  lone(caller.sessionId);
  const result = await startWorktree(caller);
  expect(result.endTurn).toBe(false);
  return result.text;
}

const temps: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function tempDir(prefix: string): Promise<string> {
  // realpath: git reports real paths (macOS /var → /private/var).
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

async function gitRepo(): Promise<string> {
  const root = await tempDir("modus-group-wt-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@modus.local");
  git(root, "config", "user.name", "Test");
  await writeFile(join(root, "README.md"), "hello\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function insertWorkspace(rootPath: string): string {
  const id = uid("ws");
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, rootPath, "repo", 1, now, now);
  return id;
}

function insertSession(workspaceId: string, cwd: string, title: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, workspaceId, title, cwd, "idle", now, now);
  return id;
}

async function squad(rootPath?: string) {
  const root = rootPath ?? (await gitRepo());
  const ws = insertWorkspace(root);
  const alpha = insertSession(ws, root, "Alpha");
  const beta = insertSession(ws, root, "Beta");
  const group = createAgentGroupWithMembers({
    name: "Squad",
    workspaceId: ws,
    members: [{ sessionId: alpha }, { sessionId: beta }],
  });
  return { root, ws, group, alpha, beta, a: { sessionId: alpha, groupId: group.id } };
}

function taskIdFrom(text: string): string {
  const id = /task (\S+) \[/.exec(text)?.[1];
  if (!id) throw new Error(`no task id in: ${text}`);
  return id;
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-group-worktree-test-"));
  ensureChatsWorkspace();
});

afterEach(() => setGroupWorktreeReadySink(undefined));

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  for (const dir of temps) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("group_start_worktree", () => {
  it("creates the member worktree from the Project HEAD and moves the session cwd into it", async () => {
    const { root, group, alpha, a } = await squad();
    const head = git(root, "rev-parse", "HEAD");

    const text = await startMemberWorktree(a);

    const session = getAgentSession(alpha);
    const worktree = session?.subagentWorktree;
    const branch = `group/${group.id}/alpha-${alpha.replace(/-/g, "").slice(0, 8)}`;
    expect(text).toContain("Worktree created:");
    expect(worktree).toMatchObject({ branch, baseSha: head, integrationStatus: "running" });
    expect(worktree?.path.startsWith(join(root, ".modus", "worktrees"))).toBe(true);
    expect(session?.cwd).toBe(worktree?.path);
    expect(git(worktree?.path ?? "", "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(git(worktree?.path ?? "", "rev-parse", "HEAD")).toBe(head);
    // The root checkout is untouched (no merge back, still on main).
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("is idempotent: a second call reuses the same path and branch, even after a rename", async () => {
    const { root, alpha, a } = await squad();
    await startMemberWorktree(a);
    const first = getAgentSession(alpha)?.subagentWorktree;
    await writeFile(join(first?.path ?? "", "work.txt"), "in progress\n");
    getDatabase().prepare("update agent_sessions set title = 'Renamed' where id = ?").run(alpha);

    const text = await startMemberWorktree(a);

    expect(text).toContain("Worktree reused:");
    expect(getAgentSession(alpha)?.subagentWorktree).toEqual(first);
    expect(existsSync(join(first?.path ?? "", "work.txt"))).toBe(true);
    const groupBranches = git(root, "branch", "--list", "group/*").split("\n");
    expect(groupBranches).toHaveLength(1);
  });

  it("a member that left and rejoined under a new title gets its old branch back", async () => {
    const { root, group, alpha, beta, a } = await squad();
    await startMemberWorktree(a);
    const first = getAgentSession(alpha)?.subagentWorktree;
    removeAgentGroupMember(group.id, alpha);
    getDatabase().prepare("update agent_sessions set title = 'Renamed' where id = ?").run(alpha);
    updateAgentGroupMembers(group.id, {
      members: [{ sessionId: alpha }, { sessionId: beta }],
      leadSessionId: null,
    });

    expect(await startMemberWorktree(a)).toContain("Worktree reused:");
    expect(getAgentSession(alpha)?.subagentWorktree?.branch).toBe(first?.branch);
    expect(getAgentSession(alpha)?.cwd).toBe(first?.path);
    expect(git(root, "branch", "--list", "group/*").split("\n")).toHaveLength(1);
  });

  it("reuses an existing member branch as-is (never reset or overwritten)", async () => {
    const { root, group, alpha, a } = await squad();
    const branch = `group/${group.id}/alpha-${alpha.replace(/-/g, "").slice(0, 8)}`;
    git(root, "branch", branch);
    git(root, "checkout", "-q", branch);
    await writeFile(join(root, "member.txt"), "earlier work\n");
    git(root, "add", "member.txt");
    git(root, "commit", "-q", "-m", "earlier member work");
    const branchTip = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "main");
    // The root moves on after the branch was made.
    await writeFile(join(root, "root.txt"), "later\n");
    git(root, "add", "root.txt");
    git(root, "commit", "-q", "-m", "root moves on");

    const text = await startMemberWorktree(a);

    const worktree = getAgentSession(alpha)?.subagentWorktree;
    expect(text).toContain("Worktree created:");
    expect(worktree?.branch).toBe(branch);
    expect(git(root, "rev-parse", branch)).toBe(branchTip);
    expect(git(worktree?.path ?? "", "rev-parse", "HEAD")).toBe(branchTip);
    expect(existsSync(join(worktree?.path ?? "", "member.txt"))).toBe(true);
    expect(existsSync(join(worktree?.path ?? "", "root.txt"))).toBe(false);
  });

  it("refuses with no-git-project when the Project is not a Git repository", async () => {
    const plain = await tempDir("modus-group-wt-plain-");
    const { alpha, a } = await squad(plain);

    expect(await startMemberWorktree(a)).toMatch(/^\[group-error:no-git-project\] /);
    expect(getAgentSession(alpha)?.cwd).toBe(plain);
    expect(getAgentSession(alpha)?.subagentWorktree).toBeUndefined();
    expect(existsSync(join(plain, ".modus"))).toBe(false);
  });

  it("refuses with no-git-project when the group has no Project", async () => {
    const chats = ensureChatsWorkspace();
    const alpha = insertSession(CHATS_WORKSPACE_ID, chats.rootPath, "Alpha");
    const group = createAgentGroupWithMembers({ name: "Inbox", members: [{ sessionId: alpha }] });

    expect(await startMemberWorktree({ sessionId: alpha, groupId: group.id })).toMatch(
      /^\[group-error:no-git-project\] /,
    );
    expect(getAgentSession(alpha)?.cwd).toBe(chats.rootPath);
  });

  it("refuses non-members with not-a-member", async () => {
    const { ws, root, group } = await squad();
    const loner = insertSession(ws, root, "Loner");

    expect(await startMemberWorktree({ sessionId: loner, groupId: group.id })).toMatch(
      /^\[group-error:not-a-member\] /,
    );
    expect(getAgentSession(loner)?.cwd).toBe(root);
  });

  it("member removal, archive and group deletion keep worktree + branch and restore the cwd", async () => {
    const leave = await squad();
    await startMemberWorktree(leave.a);
    const leftWorktree = getAgentSession(leave.alpha)?.subagentWorktree;
    removeAgentGroupMember(leave.group.id, leave.alpha);
    expect(getAgentSession(leave.alpha)?.cwd).toBe(leave.root);
    expect(getAgentSession(leave.alpha)?.subagentWorktree).toBeUndefined();
    expect(existsSync(leftWorktree?.path ?? "")).toBe(true);
    expect(git(leave.root, "branch", "--list", leftWorktree?.branch ?? "")).toContain(
      leftWorktree?.branch,
    );

    const replaced = await squad();
    await startMemberWorktree(replaced.a);
    updateAgentGroupMembers(replaced.group.id, {
      members: [{ sessionId: replaced.beta }],
      leadSessionId: null,
    });
    expect(getAgentSession(replaced.alpha)?.cwd).toBe(replaced.root);

    const archived = await squad();
    await startMemberWorktree(archived.a);
    setAgentSessionArchived(archived.alpha, true);
    expect(getAgentSession(archived.alpha)?.cwd).toBe(archived.root);

    const deleted = await squad();
    await startMemberWorktree(deleted.a);
    await startMemberWorktree({ sessionId: deleted.beta, groupId: deleted.group.id });
    const kept = [deleted.alpha, deleted.beta].map((id) => getAgentSession(id)?.subagentWorktree);
    deleteAgentGroup(deleted.group.id);
    for (const [index, id] of [deleted.alpha, deleted.beta].entries()) {
      expect(getAgentSession(id)?.cwd).toBe(deleted.root);
      expect(getAgentSession(id)?.subagentWorktree).toBeUndefined();
      expect(existsSync(kept[index]?.path ?? "")).toBe(true);
      expect(git(deleted.root, "rev-parse", "--verify", kept[index]?.branch ?? "")).not.toBe("");
    }
    // No merge back: the root is still clean on main.
    expect(git(deleted.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("fills branch on the member's in_progress tasks without one, never overwriting", async () => {
    const { group, alpha, beta, a } = await squad();
    const mine = taskIdFrom(runGroupTool("group_create_task", a, { title: "Mine" }));
    runGroupTool("group_claim_task", a, { id: mine });
    const preset = createGroupTask({
      groupId: group.id,
      title: "Preset",
      status: "in_progress",
      ownerSessionId: alpha,
      branch: "feature/preset",
    });
    const open = taskIdFrom(runGroupTool("group_create_task", a, { title: "Open" }));
    const theirs = taskIdFrom(runGroupTool("group_create_task", a, { title: "Theirs" }));
    runGroupTool("group_claim_task", { sessionId: beta, groupId: group.id }, { id: theirs });

    const text = await startMemberWorktree(a);

    const branch = getAgentSession(alpha)?.subagentWorktree?.branch;
    const byId = new Map(listGroupTasks(group.id).map((task) => [task.id, task]));
    expect(byId.get(mine)?.branch).toBe(branch);
    expect(text).toContain(mine);
    expect(byId.get(preset.id)?.branch).toBe("feature/preset");
    expect(byId.get(open)?.branch).toBeUndefined();
    expect(byId.get(theirs)?.branch).toBeUndefined();
  });

  it("group_claim_task fills branch when the claimer already has a worktree, never overwriting", async () => {
    const { group, alpha, beta, a } = await squad();
    await startMemberWorktree(a);
    const branch = getAgentSession(alpha)?.subagentWorktree?.branch;
    const fresh = taskIdFrom(runGroupTool("group_create_task", a, { title: "Fresh" }));
    const preset = createGroupTask({
      groupId: group.id,
      title: "Preset",
      branch: "feature/preset",
    });

    expect(runGroupTool("group_claim_task", a, { id: fresh })).toContain(`branch=${branch}`);
    runGroupTool("group_claim_task", a, { id: preset.id });
    // A member without a worktree claims without a branch.
    const other = taskIdFrom(runGroupTool("group_create_task", a, { title: "Other" }));
    runGroupTool("group_claim_task", { sessionId: beta, groupId: group.id }, { id: other });

    const byId = new Map(listGroupTasks(group.id).map((task) => [task.id, task]));
    expect(byId.get(fresh)?.branch).toBe(branch);
    expect(byId.get(preset.id)?.branch).toBe("feature/preset");
    expect(byId.get(other)?.branch).toBeUndefined();
  });
});

describe("group_start_worktree in a group turn (turn end + re-wake)", () => {
  it("moving the cwd inside the member's group turn ends the turn (PI terminate)", async () => {
    const { group, alpha, ws, root } = await squad();
    const sink = vi.fn(() => true);
    setGroupWorktreeReadySink(sink);
    registerGroupTools();
    const definition = toolRegistry
      .getCustomToolDefinitions("chat")
      .find((candidate) => candidate.name === "group_start_worktree");
    const execute = definition?.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: { cwd: string },
    ) => Promise<{ content: Array<{ text: string }>; terminate?: boolean }>;
    setAgentToolContext({ workspaceId: ws, cwd: root, sessionId: alpha, groupId: group.id });

    lone(alpha);
    const result = await execute("call-1", {}, undefined, undefined, { cwd: root });

    const branch = getAgentSession(alpha)?.subagentWorktree?.branch;
    expect(sink).toHaveBeenCalledWith({ groupId: group.id, sessionId: alpha, branch });
    expect(result.terminate).toBe(true);
    expect(result.content[0]?.text).toContain("Your turn ends now");
    expect(getAgentSession(alpha)?.cwd).toBe(getAgentSession(alpha)?.subagentWorktree?.path);

    // Idempotent call with the cwd already there: no turn end, no re-wake.
    sink.mockClear();
    lone(alpha);
    const again = await execute("call-2", {}, undefined, undefined, { cwd: root });
    expect(sink).not.toHaveBeenCalled();
    expect(again.terminate).toBeUndefined();
    expect(again.content[0]?.text).toContain("You are already working in it.");
  });

  it("outside a group turn the cwd is saved, nothing ends and it applies from the next message", async () => {
    const { alpha, a } = await squad();
    const sink = vi.fn(() => false);
    setGroupWorktreeReadySink(sink);

    lone(alpha);
    const result = await startWorktree(a);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(result.endTurn).toBe(false);
    expect(result.text).toContain("from your next message");
    expect(getAgentSession(alpha)?.cwd).toBe(getAgentSession(alpha)?.subagentWorktree?.path);
  });

  it("refuses with branch-checked-out when the member branch is checked out outside .modus/worktrees", async () => {
    const { root, group, alpha, a } = await squad();
    const sink = vi.fn(() => true);
    setGroupWorktreeReadySink(sink);
    const branch = `group/${group.id}/alpha-${alpha.replace(/-/g, "").slice(0, 8)}`;
    git(root, "checkout", "-q", "-b", branch);

    lone(alpha);
    const result = await startWorktree(a);

    expect(result.endTurn).toBe(false);
    expect(result.text).toMatch(/^\[group-error:branch-checked-out\] /);
    expect(result.text).toContain(root);
    expect(result.text).toContain("Do not retry");
    expect(sink).not.toHaveBeenCalled();
    expect(getAgentSession(alpha)?.cwd).toBe(root);
    expect(getAgentSession(alpha)?.subagentWorktree).toBeUndefined();
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
  });
});

describe("group_start_worktree must be called alone", () => {
  async function untouched(input: Awaited<ReturnType<typeof squad>>, taskId: string) {
    const session = getAgentSession(input.alpha);
    expect(session?.cwd).toBe(input.root);
    expect(session?.subagentWorktree).toBeUndefined();
    const row = getDatabase()
      .prepare(
        "select subagent_worktree_path, subagent_worktree_branch from agent_sessions where id = ?",
      )
      .get(input.alpha) as Record<string, unknown>;
    expect(row).toEqual({ subagent_worktree_path: null, subagent_worktree_branch: null });
    expect(
      listGroupTasks(input.group.id).find((task) => task.id === taskId)?.branch,
    ).toBeUndefined();
    expect(git(input.root, "branch", "--list", "group/*")).toBe("");
    expect(existsSync(join(input.root, ".modus", "worktrees"))).toBe(false);
    expect(git(input.root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(
      1,
    );
  }

  it("a batch with two tool calls is refused with no effect; a lone call right after works", async () => {
    const input = await squad();
    const { alpha, a } = input;
    const taskId = taskIdFrom(runGroupTool("group_create_task", a, { title: "Mine" }));
    runGroupTool("group_claim_task", a, { id: taskId });
    const sink = vi.fn(() => true);
    setGroupWorktreeReadySink(sink);

    assistantMessage(alpha, ["group_start_worktree", "bash"]);
    const refused = await startWorktree(a);

    expect(refused.endTurn).toBe(false);
    expect(refused.text).toMatch(/^\[group-error:call-alone\] /);
    expect(refused.text).toContain("call group_start_worktree alone in its own message");
    expect(sink).not.toHaveBeenCalled();
    await untouched(input, taskId);

    lone(alpha);
    const accepted = await startWorktree(a);
    expect(accepted.endTurn).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    const worktree = getAgentSession(alpha)?.subagentWorktree;
    expect(getAgentSession(alpha)?.cwd).toBe(worktree?.path);
    expect(listGroupTasks(input.group.id).find((task) => task.id === taskId)?.branch).toBe(
      worktree?.branch,
    );
  });

  it("refuses with call-alone when no assistant message was recorded for the session", async () => {
    const input = await squad();
    const taskId = taskIdFrom(runGroupTool("group_create_task", input.a, { title: "Mine" }));
    runGroupTool("group_claim_task", input.a, { id: taskId });
    clearAssistantToolCallCount(input.alpha);

    const refused = await startWorktree(input.a);

    expect(refused).toMatchObject({ endTurn: false });
    expect(refused.text).toMatch(/^\[group-error:call-alone\] /);
    expect(refused.text).toContain("call group_start_worktree alone in its own message");
    await untouched(input, taskId);
  });
});

describe("group_assign_task reassignment keeps the task's branch (coordinator mode)", () => {
  it("the old owner's branch survives the reassignment and the new owner's group_start_worktree", async () => {
    const { group, alpha, beta, a } = await squad();
    setAgentGroupLead(group.id, alpha);
    setAgentGroupMode(group.id, "coordinator");
    const bodies: string[] = [];
    setGroupTaskWakeSink((wake) => bodies.push(wake.body));
    try {
      await startMemberWorktree(a);
      const alphaBranch = getAgentSession(alpha)?.subagentWorktree?.branch ?? "";
      expect(alphaBranch).not.toBe("");
      const worked = taskIdFrom(runGroupTool("group_create_task", a, { title: "Worked" }));
      const bare = taskIdFrom(runGroupTool("group_create_task", a, { title: "Bare" }));
      runGroupTool("group_claim_task", a, { id: worked });
      // A bare in_progress task: claimed by Beta before any worktree.
      runGroupTool("group_claim_task", { sessionId: beta, groupId: group.id }, { id: bare });
      const branchOf = (id: string) =>
        listGroupTasks(group.id).find((task) => task.id === id)?.branch;
      expect(branchOf(worked)).toBe(alphaBranch);

      runGroupTool("group_assign_task", a, { taskId: worked, memberId: "Beta" });
      // 1. Unchanged right after the reassignment; 3. the line names it.
      expect(branchOf(worked)).toBe(alphaBranch);
      expect(bodies.at(-1)).toBe(
        `Reassigned: "Worked" (task ${worked}): @Alpha → @Beta (branch: \`${alphaBranch}\`)`,
      );

      // 2. The new owner's worktree fills only null branches.
      await startMemberWorktree({ sessionId: beta, groupId: group.id });
      const betaBranch = getAgentSession(beta)?.subagentWorktree?.branch ?? "";
      expect(betaBranch).not.toBe("");
      expect(betaBranch).not.toBe(alphaBranch);
      expect(branchOf(worked)).toBe(alphaBranch);
      expect(branchOf(bare)).toBe(betaBranch);

      // Reassigning back keeps the recorded branch too.
      runGroupTool("group_assign_task", a, { taskId: worked, memberId: "Alpha" });
      expect(branchOf(worked)).toBe(alphaBranch);
    } finally {
      setGroupTaskWakeSink(undefined);
    }
  });
});
