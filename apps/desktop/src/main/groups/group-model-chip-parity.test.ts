/**
 * C5 parity: the renderer's read-only model chip and the runtime resolve the
 * SAME targets for the same room. Each scenario builds a real room (DB +
 * GroupRuntime with a fake agent runtime), computes the chip from the data
 * the renderer gets (AgentGroupWithMembers + room messages), posts the same
 * draft, and compares the chip's target set with who the runtime woke.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  archivedMemberIds,
  groupModelChip,
  replyAuthorOf,
} from "../../renderer/src/features/groups/groupModelChip";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../db/database");
const { ensureChatsWorkspace } = await import("../workspace/workspace-store");
const { createAgent, setAgentArchived } = await import("../agents/agents-store");
const {
  createAgentGroupWithAgents,
  getAgentGroupWithMembers,
  listGroupMessages,
  setAgentGroupLead,
  setAgentGroupMode,
} = await import("./group-store");
const { GroupRuntime } = await import("./group-runtime");
const { selectAutonomousWakeTargets } = await import("./group-runtime-lib");
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

type Call = { input: PromptAgentInput; resolve(result: PromptTurnResult): void };

class FakeAgentRuntime {
  calls: Call[] = [];
  async abort(): Promise<void> {}
  prompt(_window: unknown, input: PromptAgentInput): Promise<PromptTurnResult> {
    return new Promise((resolve) => this.calls.push({ input, resolve }));
  }
  isSessionStreaming(): boolean {
    return false;
  }
  onTurnSettled(_listener: (event: TurnSettledEvent) => void): () => void {
    return () => undefined;
  }
  onQuestionPending(_listener: (sessionId: string) => void): () => void {
    return () => undefined;
  }
  take(sessionId: string): Call {
    const index = this.calls.findIndex((call) => call.input.sessionId === sessionId);
    if (index < 0) throw new Error(`no pending prompt for ${sessionId}`);
    const [call] = this.calls.splice(index, 1);
    return call as Call;
  }
  pending(): string[] {
    return this.calls.map((call) => call.input.sessionId).sort();
  }
}

const created: InstanceType<typeof GroupRuntime>[] = [];
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function setup() {
  const runtime = new FakeAgentRuntime();
  const groups = new GroupRuntime({
    runtime: runtime as never,
    host: { getWindow: () => ({}) as never, isUpdatePending: () => false, emit: () => undefined },
    retryDelayMs: 5,
    maxConcurrentTurns: 10,
  });
  created.push(groups);
  return { runtime, groups };
}

/** Lead (gpt-5), Builder (sonnet), Reviewer (no modelId). */
function makeRoom() {
  const lead = createAgent({ name: uid("Lead"), role: "Lead", modelId: "gpt-5" });
  const builder = createAgent({ name: uid("Builder"), role: "Builder", modelId: "sonnet" });
  const reviewer = createAgent({ name: uid("Reviewer"), role: "Reviewer" });
  const group = createAgentGroupWithAgents({
    name: "Parity room",
    workspaceId: insertWorkspace(),
    members: [{ agentId: lead.id }, { agentId: builder.id }, { agentId: reviewer.id }],
    leadAgentId: lead.id,
  });
  const session = (agentId: string) =>
    group.members.find((member) => member.agentId === agentId)?.sessionId ?? "";
  return {
    groupId: group.id,
    agents: { lead, builder, reviewer },
    s: { lead: session(lead.id), builder: session(builder.id), reviewer: session(reviewer.id) },
    models: new Map([
      [session(lead.id), lead.modelId],
      [session(builder.id), builder.modelId],
      [session(reviewer.id), reviewer.modelId],
    ]),
  };
}

/** The chip exactly as GroupRoom → GroupComposer computes it. */
function chipFor(room: ReturnType<typeof makeRoom>, draft: string, replyToMessageId?: string) {
  const group = getAgentGroupWithMembers(room.groupId);
  const messages = listGroupMessages(room.groupId, { limit: 200 });
  const chip = groupModelChip({
    draft,
    members: group.members.map((member) => ({ sessionId: member.sessionId, title: member.name })),
    memberModels: room.models,
    leadSessionId: group.leadSessionId,
    mode: group.mode,
    archivedSessionIds: archivedMemberIds(group.members),
    replyAuthorSessionId: replyAuthorOf(messages, replyToMessageId),
    models: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "sonnet", name: "Sonnet" },
    ],
    locale: "pt-BR",
  });
  if (!chip) throw new Error("no chip");
  return chip;
}

/** Posts the same draft and returns who the runtime woke. */
function wake(
  room: ReturnType<typeof makeRoom>,
  runtime: FakeAgentRuntime,
  groups: InstanceType<typeof GroupRuntime>,
  body: string,
  replyToMessageId?: string,
): string[] {
  const before = new Set(runtime.calls.map((call) => call));
  groups.postUserMessage({
    groupId: room.groupId,
    body,
    ...(replyToMessageId ? { replyToMessageId } : {}),
  });
  return runtime.calls
    .filter((call) => !before.has(call))
    .map((call) => call.input.sessionId)
    .sort();
}

function lastBody(groupId: string): string | undefined {
  return listGroupMessages(groupId, { limit: 200 }).at(-1)?.body;
}

/** An agent message by `sessionId` to reply to. */
async function agentMessage(
  room: ReturnType<typeof makeRoom>,
  runtime: FakeAgentRuntime,
  groups: InstanceType<typeof GroupRuntime>,
  sessionId: string,
  name: string,
): Promise<string> {
  groups.postUserMessage({ groupId: room.groupId, body: `@${name} status?` });
  runtime.take(sessionId).resolve({ outcome: "ok", finalText: "Done." });
  await flush();
  const message = listGroupMessages(room.groupId, { limit: 200 })
    .filter((item) => item.authorSessionId === sessionId && item.body === "Done.")
    .at(-1);
  if (!message) throw new Error("agent message missing");
  return message.id;
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-chip-parity-test-"));
  ensureChatsWorkspace();
});

afterEach(() => {
  for (const runtime of created.splice(0)) runtime.dispose();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("model chip ⇔ runtime wake parity", () => {
  it("coordinator mode, active Lead: both target the Lead", () => {
    const room = makeRoom();
    setAgentGroupMode(room.groupId, "coordinator");
    const { runtime, groups } = setup();
    const chip = chipFor(room, "Plan the release");
    expect(chip).toMatchObject({ rule: "coordinator", kind: "lead", label: "GPT-5" });
    expect(wake(room, runtime, groups, "Plan the release")).toEqual([...chip.targets].sort());
  });

  it("coordinator mode, archived Lead: nobody wakes; chip warns 'Lead arquivado'", () => {
    const room = makeRoom();
    setAgentGroupMode(room.groupId, "coordinator");
    setAgentArchived(room.agents.lead.id, true);
    const { runtime, groups } = setup();
    const chip = chipFor(room, "Plan the release");
    expect(chip).toMatchObject({ kind: "nobody", warning: true, label: "Lead arquivado" });
    expect(chip.tooltip).toBe(
      "Ninguém vai responder. Mencione um membro ativo ou desarquive o Lead",
    );
    expect(wake(room, runtime, groups, "Plan the release")).toEqual(chip.targets);
    expect(chip.targets).toEqual([]);
    expect(lastBody(room.groupId)).toBe(`${room.agents.lead.name} is archived`);
  });

  it("autonomous mode, archived Lead: no-Lead case with ACTIVE members only", async () => {
    const room = makeRoom();
    setAgentGroupMode(room.groupId, "free");
    setAgentArchived(room.agents.lead.id, true);
    const { runtime, groups } = setup();
    for (const body of ["oi", "please review the PR", "build the release", "fix the tests"]) {
      const chip = chipFor(room, body);
      expect(chip.kind).toBe("noLead");
      expect([...chip.targets].sort()).toEqual([room.s.builder, room.s.reviewer].sort());
      expect(chip.entries.map((entry) => entry.sessionId)).not.toContain(room.s.lead);
      // The runtime's specialty pick is always inside the chip's eligible pool …
      const woken = wake(room, runtime, groups, body);
      expect(woken.length).toBeGreaterThan(0);
      for (const id of woken) expect(chip.targets).toContain(id);
      for (const id of woken) runtime.take(id).resolve({ outcome: "ok", finalText: "ok" });
      await flush();
      // … and that pool is exactly what selectAutonomousWakeTargets may choose from.
      const members = getAgentGroupWithMembers(room.groupId).members.map((member) => ({
        sessionId: member.sessionId,
        title: member.name,
        role: member.agentRole,
        ...(member.archived ? { archived: true } : {}),
      }));
      const reachable = new Set<string>();
      const pool = [...members];
      while (true) {
        const [pick] = selectAutonomousWakeTargets({
          body,
          members: pool,
          leadSessionId: room.s.lead,
          excludeSessionIds: [...reachable],
        });
        if (!pick) break;
        reachable.add(pick);
      }
      expect([...reachable].sort()).toEqual([...chip.targets].sort());
    }
  });

  it("autonomous mode, active Lead: Lead model by default; pick stays in the pool", async () => {
    const room = makeRoom();
    setAgentGroupMode(room.groupId, "free");
    const { runtime, groups } = setup();
    const chip = chipFor(room, "oi");
    expect(chip).toMatchObject({ rule: "autonomous", kind: "lead", label: "GPT-5" });
    expect(chip.tooltip.split("\n")[0]).toBe("Lead responde por padrão");
    expect(wake(room, runtime, groups, "oi")).toEqual([room.s.lead]);
    runtime.take(room.s.lead).resolve({ outcome: "ok", finalText: "oi!" });
    await flush();
    for (const id of wake(room, runtime, groups, "please review the PR")) {
      expect(chip.targets).toContain(id);
    }
  });

  it("all mentioned archived: nobody wakes; chip warns 'Arquivado'", () => {
    const room = makeRoom();
    setAgentArchived(room.agents.builder.id, true);
    setAgentArchived(room.agents.reviewer.id, true);
    const { runtime, groups } = setup();
    const body = `@${room.agents.builder.name} @${room.agents.reviewer.name} go`;
    const chip = chipFor(room, body);
    expect(chip).toMatchObject({ kind: "nobody", warning: true, label: "Arquivado" });
    expect(chip.tooltip.split("\n")[0]).toBe(
      "Ninguém vai responder. Mencione um membro ativo ou desarquive o agente",
    );
    expect(wake(room, runtime, groups, body)).toEqual(chip.targets);
    expect(chip.targets).toEqual([]);
  });

  it("mixed active/archived mentions: only the active ones (and the chip counts only them)", () => {
    const room = makeRoom();
    setAgentArchived(room.agents.reviewer.id, true);
    const { runtime, groups } = setup();
    const body = `@${room.agents.lead.name} @${room.agents.builder.name} @${room.agents.reviewer.name} go`;
    const chip = chipFor(room, body);
    expect(chip).toMatchObject({ kind: "multiple", label: "2 modelos", warning: false });
    expect(chip.tooltip).toContain(`Arquivado, não será acordado: ${room.agents.reviewer.name}`);
    expect(wake(room, runtime, groups, body)).toEqual([...chip.targets].sort());
    expect([...chip.targets].sort()).toEqual([room.s.lead, room.s.builder].sort());
  });

  it("mentions win over a reply and over coordinator mode", async () => {
    const room = makeRoom();
    setAgentGroupMode(room.groupId, "coordinator");
    const { runtime, groups } = setup();
    const replyTo = await agentMessage(room, runtime, groups, room.s.lead, room.agents.lead.name);
    const body = `@${room.agents.builder.name} take it`;
    const chip = chipFor(room, body, replyTo);
    expect(chip).toMatchObject({ rule: "mention", kind: "single", label: "Sonnet" });
    expect(wake(room, runtime, groups, body, replyTo)).toEqual(chip.targets);
  });

  it("thread reply without @ goes to the active author, before coordinator mode", async () => {
    const room = makeRoom();
    setAgentGroupMode(room.groupId, "coordinator");
    const { runtime, groups } = setup();
    const replyTo = await agentMessage(
      room,
      runtime,
      groups,
      room.s.builder,
      room.agents.builder.name,
    );
    const chip = chipFor(room, "and the tests?", replyTo);
    expect(chip).toMatchObject({ rule: "reply", kind: "reply", label: "Sonnet" });
    expect(wake(room, runtime, groups, "and the tests?", replyTo)).toEqual(chip.targets);
    expect(chip.targets).toEqual([room.s.builder]);
  });

  it("thread reply to an archived author: nobody wakes; chip warns 'Arquivado'", async () => {
    const room = makeRoom();
    const { runtime, groups } = setup();
    const replyTo = await agentMessage(
      room,
      runtime,
      groups,
      room.s.reviewer,
      room.agents.reviewer.name,
    );
    setAgentArchived(room.agents.reviewer.id, true);
    const chip = chipFor(room, "thanks, and then?", replyTo);
    expect(chip).toMatchObject({
      rule: "reply",
      kind: "nobody",
      warning: true,
      label: "Arquivado",
    });
    expect(chip.tooltip.split("\n")[0]).toBe(
      "Ninguém vai responder. Mencione um membro ativo ou desarquive o agente",
    );
    expect(wake(room, runtime, groups, "thanks, and then?", replyTo)).toEqual(chip.targets);
    expect(lastBody(room.groupId)).toBe(`${room.agents.reviewer.name} is archived`);
  });

  it("reply to a user message falls through to the room mode (same on both sides)", async () => {
    const room = makeRoom();
    setAgentGroupMode(room.groupId, "coordinator");
    setAgentGroupLead(room.groupId, room.s.builder);
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: room.groupId, body: "note for later" });
    runtime.take(room.s.builder).resolve({ outcome: "ok", finalText: "Noted." });
    await flush();
    const chip = chipFor(room, "follow-up", user.id);
    expect(chip).toMatchObject({ rule: "coordinator", kind: "lead", label: "Sonnet" });
    expect(wake(room, runtime, groups, "follow-up", user.id)).toEqual(chip.targets);
  });
});
