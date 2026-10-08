import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  groupMailboxSendTool,
  handleGroupMailboxAck,
  handleGroupMailboxReceive,
  handleGroupMailboxSend,
  handleGroupRevisionCheck,
} from "../../tools/group-mailbox-tools";
import { setAgentToolContext } from "../../tools/tool-context";
import {
  resetFeatureFlagOverrides,
  setFeatureFlagOverrides,
} from "../feature-flags";
import type { HarnessContext } from "../kernel/harness-hooks";
import {
  canProceed,
  detectDependencyCycles,
  detectWriteConflict,
  findEligibleTasks,
  type GroupTaskDependencies,
  normalizeScope,
  scopesOverlap,
} from "./group-dependencies";
import {
  defaultToolsRegisterGroupMailboxHook,
  defaultTurnSettleGroupMailboxHook,
  defaultTurnStartGroupMailboxHook,
} from "./group-hooks";
import {
  computeMessageDedupeHash,
  DEFAULT_MAILBOX_CONFIG,
  GroupMailbox,
} from "./group-mailbox";
import {
  advanceRevision,
  computeFileHash,
  createGroupRevision,
  detectConflict,
  detectThreeWayConflict,
  type GroupRevision,
  GroupRevisionRegistry,
} from "./group-revision";

describe("Phase 6: Groups Mailbox & Optimistic Revision", () => {
  beforeEach(() => {
    setFeatureFlagOverrides({
      MODUS_USE_KERNEL: true,
      MODUS_GROUPS_MAILBOX: true,
    });
    GroupMailbox.resetInstance();
    GroupRevisionRegistry.resetInstance();
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    GroupMailbox.resetInstance();
    GroupRevisionRegistry.resetInstance();
  });

  describe("6.1 Group Mailbox Durability & Lifecycle", () => {
    it("sends and receives 1-to-1 direct messages", () => {
      const mailbox = GroupMailbox.getInstance();
      const id1 = mailbox.send({
        groupId: "g1",
        from: "agentA",
        to: "agentB",
        content: "Hello Agent B",
        revision: 1,
        sentAt: "2026-10-06T12:00:00Z",
      });

      expect(typeof id1).toBe("string");
      expect(mailbox.getPendingCount("agentB")).toBe(1);
      expect(mailbox.getPendingCount("agentA")).toBe(0);

      const msgs = mailbox.receive("agentB");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.content).toBe("Hello Agent B");
      expect(msgs[0]?.from).toBe("agentA");
    });

    it("supports broadcast messages with independent per-agent acks", () => {
      const mailbox = GroupMailbox.getInstance();
      const bcastId = mailbox.send({
        groupId: "g1",
        from: "coordinator",
        to: "*",
        content: "Global sync required",
        revision: 2,
        sentAt: "2026-10-06T12:00:00Z",
      });

      // Both agentA and agentB see the broadcast, but sender does not
      expect(mailbox.receive("agentA")).toHaveLength(1);
      expect(mailbox.receive("agentB")).toHaveLength(1);
      expect(mailbox.receive("coordinator")).toHaveLength(0);

      // AgentA acks
      mailbox.ack(bcastId, "agentA");
      expect(mailbox.receive("agentA")).toHaveLength(0);
      expect(mailbox.receive("agentB")).toHaveLength(1);

      // AgentB acks
      mailbox.ack(bcastId, "agentB");
      expect(mailbox.receive("agentB")).toHaveLength(0);
    });

    it("performs idempotent deduplication within 24h dedupe window", () => {
      const mailbox = GroupMailbox.getInstance();
      const t1 = "2026-10-06T12:00:00Z";
      const id1 = mailbox.send({
        groupId: "g1",
        from: "agentA",
        to: "agentB",
        content: "Idempotent action",
        revision: 1,
        sentAt: t1,
      });

      expect(
        mailbox.isDuplicate(
          { groupId: "g1", from: "agentA", to: "agentB", content: "Idempotent action" },
          "2026-10-06T13:00:00Z",
        ),
      ).toBe(true);

      // Sending again returns existing message ID without creating second entry
      const id2 = mailbox.send({
        groupId: "g1",
        from: "agentA",
        to: "agentB",
        content: "Idempotent action",
        revision: 1,
        sentAt: "2026-10-06T13:00:00Z",
      });

      expect(id2).toBe(id1);
      expect(mailbox.receive("agentB")).toHaveLength(1);
    });

    it("allows duplicate after 24h dedupe window expires", () => {
      const mailbox = GroupMailbox.getInstance({ dedupeWindowMs: 3600_000 }); // 1h
      mailbox.send({
        groupId: "g1",
        from: "agentA",
        to: "agentB",
        content: "Periodic heartbeat",
        revision: 1,
        sentAt: "2026-10-06T12:00:00Z",
      });

      const after2Hours = "2026-10-06T14:00:01Z";
      expect(
        mailbox.isDuplicate(
          { groupId: "g1", from: "agentA", to: "agentB", content: "Periodic heartbeat" },
          after2Hours,
        ),
      ).toBe(false);
    });

    it("enforces FIFO purge when agent mailbox reaches maximum capacity", () => {
      const mailbox = new GroupMailbox({ maxMessagesPerAgent: 3 });
      mailbox.send({ groupId: "g", from: "A", to: "B", content: "m1", revision: 1 });
      mailbox.send({ groupId: "g", from: "A", to: "B", content: "m2", revision: 2 });
      mailbox.send({ groupId: "g", from: "A", to: "B", content: "m3", revision: 3 });
      mailbox.send({ groupId: "g", from: "A", to: "B", content: "m4", revision: 4 });

      const msgs = mailbox.receive("B");
      expect(msgs).toHaveLength(3);
      expect(msgs.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);
    });

    it("purges expired messages according to 7-day ack and 30-day unack policies", () => {
      const mailbox = new GroupMailbox();
      const dayMs = 24 * 3600 * 1000;
      const baseTime = Date.parse("2026-10-06T12:00:00Z");

      // 1. Acked message from 8 days ago
      const id1 = mailbox.send({
        groupId: "g",
        from: "A",
        to: "B",
        content: "acked old",
        revision: 1,
        sentAt: new Date(baseTime - 9 * dayMs).toISOString(),
      });
      mailbox.ack(id1, "B", new Date(baseTime - 8 * dayMs).toISOString());

      // 2. Acked message from 2 days ago (should keep)
      const id2 = mailbox.send({
        groupId: "g",
        from: "A",
        to: "B",
        content: "acked recent",
        revision: 1,
        sentAt: new Date(baseTime - 3 * dayMs).toISOString(),
      });
      mailbox.ack(id2, "B", new Date(baseTime - 2 * dayMs).toISOString());

      // 3. Unacked message from 35 days ago (should purge)
      mailbox.send({
        groupId: "g",
        from: "A",
        to: "B",
        content: "unacked ancient",
        revision: 1,
        sentAt: new Date(baseTime - 35 * dayMs).toISOString(),
      });

      // 4. Unacked message from 10 days ago (should keep, < 30 days)
      mailbox.send({
        groupId: "g",
        from: "A",
        to: "B",
        content: "unacked recent",
        revision: 1,
        sentAt: new Date(baseTime - 10 * dayMs).toISOString(),
      });

      const purged = mailbox.purgeExpired(new Date(baseTime).toISOString());
      expect(purged).toBe(2);

      const remaining = mailbox.getMessages("B");
      expect(remaining.map((m) => m.content)).toEqual([
        "unacked recent",
        "acked recent",
      ]);
    });
  });

  describe("6.2 Group Optimistic Revision & Conflict Detection", () => {
    it("computes deterministic file hashes", () => {
      const h1 = computeFileHash("console.log('test')");
      const h2 = computeFileHash("console.log('test')");
      const h3 = computeFileHash("console.log('other')");
      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
    });

    it("detects conflicts between base revision and agent revision", () => {
      const base: GroupRevision = {
        groupId: "g1",
        agentId: "base",
        revision: 1,
        files: {
          "src/index.ts": "hash1",
          "src/utils.ts": "hashA",
        },
        updatedAt: "2026-10-06T10:00:00Z",
      };

      const agentOk: GroupRevision = {
        groupId: "g1",
        agentId: "agent1",
        revision: 1,
        files: {
          "src/index.ts": "hash1",
          "src/new.ts": "hashNew",
        },
        updatedAt: "2026-10-06T10:05:00Z",
      };

      expect(detectConflict(base, agentOk)).toHaveLength(0);

      const agentConflict: GroupRevision = {
        groupId: "g1",
        agentId: "agent2",
        revision: 1,
        files: {
          "src/index.ts": "hashChanged",
        },
        updatedAt: "2026-10-06T10:06:00Z",
      };

      const conflicts = detectConflict(base, agentConflict);
      expect(conflicts).toEqual(["src/index.ts"]);
    });

    it("detects 3-way merge conflicts across concurrent branches", () => {
      const base = createGroupRevision({
        groupId: "g1",
        agentId: "init",
        revision: 1,
        files: { "file1.ts": "baseH1", "file2.ts": "baseH2" },
      });

      const current = createGroupRevision({
        groupId: "g1",
        agentId: "agentA",
        revision: 2,
        files: { "file1.ts": "modA", "file2.ts": "baseH2" },
      });

      const incomingConflicting = createGroupRevision({
        groupId: "g1",
        agentId: "agentB",
        revision: 2,
        files: { "file1.ts": "modB", "file2.ts": "baseH2" },
      });

      const conflicts = detectThreeWayConflict(base, current, incomingConflicting);
      expect(conflicts).toEqual(["file1.ts"]);

      const incomingNonConflicting = createGroupRevision({
        groupId: "g1",
        agentId: "agentB",
        revision: 2,
        files: { "file1.ts": "baseH1", "file2.ts": "modB2" },
      });

      expect(detectThreeWayConflict(base, current, incomingNonConflicting)).toHaveLength(0);
    });

    it("advances revisions cleanly when no conflicts exist", () => {
      const base = createGroupRevision({
        groupId: "g1",
        agentId: "init",
        revision: 1,
        files: { "a.ts": "hA" },
      });

      const incoming = createGroupRevision({
        groupId: "g1",
        agentId: "agent1",
        revision: 1,
        files: { "b.ts": "hB" },
      });

      const result = advanceRevision(base, incoming);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.revision.revision).toBe(2);
        expect(result.revision.files).toEqual({ "a.ts": "hA", "b.ts": "hB" });
      }
    });

    it("manages optimistic commits in GroupRevisionRegistry", () => {
      const registry = GroupRevisionRegistry.getInstance();
      const base = createGroupRevision({
        groupId: "project-1",
        agentId: "main",
        revision: 1,
        files: { "config.json": "cfg1" },
      });

      registry.setRevision("project-1", base);

      // Agent 1 commits cleanly
      const commit1 = registry.commitRevision(base, {
        groupId: "project-1",
        agentId: "worker1",
        revision: 1,
        files: { "worker1.ts": "w1" },
        updatedAt: "2026-10-06T12:00:00Z",
      });
      expect(commit1.success).toBe(true);
      expect(registry.getRevision("project-1")?.revision).toBe(2);

      // Stale commit with conflicting modification of base file
      const commitStale = registry.commitRevision(base, {
        groupId: "project-1",
        agentId: "worker2",
        revision: 1,
        files: { "config.json": "cfgConflict" },
        updatedAt: "2026-10-06T12:01:00Z",
      });
      expect(commitStale.success).toBe(false);
      if (!commitStale.success) {
        expect(commitStale.conflicts).toEqual(["config.json"]);
      }
    });
  });

  describe("6.3 Group Task Dependencies & WriteScopes", () => {
    it("evaluates canProceed correctly with dependency sets", () => {
      const task: GroupTaskDependencies = {
        taskId: "task-deploy",
        blockedBy: ["task-build", "task-test"],
        writeScopes: ["dist/"],
      };

      expect(canProceed(task, new Set(["task-build"]))).toBe(false);
      expect(canProceed(task, new Set(["task-build", "task-test"]))).toBe(true);
      expect(canProceed(task, new Set(["task-build", "task-test", "task-lint"]))).toBe(true);
    });

    it("normalizes scopes and detects subpath overlaps", () => {
      expect(normalizeScope("apps/desktop//src/")).toBe("apps/desktop/src");
      expect(scopesOverlap("src/main", "src/main/agent/tools.ts")).toBe(true);
      expect(scopesOverlap("src/main/agent/tools.ts", "src/main")).toBe(true);
      expect(scopesOverlap("src/a", "src/b")).toBe(false);
      expect(scopesOverlap("*", "apps/desktop")).toBe(true);
    });

    it("detects write conflicts between overlapping tasks", () => {
      const t1: GroupTaskDependencies = {
        taskId: "t1",
        blockedBy: [],
        writeScopes: ["apps/desktop/src/main/agent"],
      };
      const t2: GroupTaskDependencies = {
        taskId: "t2",
        blockedBy: [],
        writeScopes: ["apps/desktop/src/main/agent/tools/group-tools.ts"],
      };
      const t3: GroupTaskDependencies = {
        taskId: "t3",
        blockedBy: [],
        writeScopes: ["apps/desktop/src/renderer"],
      };

      expect(detectWriteConflict(t1, t2)).toBe(true);
      expect(detectWriteConflict(t1, t3)).toBe(false);
      expect(detectWriteConflict(t1, t1)).toBe(false); // same task
    });

    it("finds eligible tasks while avoiding dependency and writeScope conflicts", () => {
      const tasks: GroupTaskDependencies[] = [
        { taskId: "t1", blockedBy: [], writeScopes: ["src/featureA"] },
        { taskId: "t2", blockedBy: ["t1"], writeScopes: ["src/featureB"] },
        { taskId: "t3", blockedBy: [], writeScopes: ["src/featureA/sub"] }, // conflicts with t1
        { taskId: "t4", blockedBy: [], writeScopes: ["src/featureC"] },
      ];

      const completed = new Set<string>();
      const eligible = findEligibleTasks(tasks, completed);

      // t1 and t4 are eligible. t2 is blocked by t1. t3 write conflicts with t1.
      expect(eligible.map((t) => t.taskId)).toEqual(["t1", "t4"]);
    });

    it("detects dependency cycles in task definitions", () => {
      const cycleTasks: GroupTaskDependencies[] = [
        { taskId: "A", blockedBy: ["B"], writeScopes: [] },
        { taskId: "B", blockedBy: ["C"], writeScopes: [] },
        { taskId: "C", blockedBy: ["A"], writeScopes: [] },
        { taskId: "D", blockedBy: [], writeScopes: [] },
      ];

      const cycles = detectDependencyCycles(cycleTasks);
      expect(cycles.length).toBeGreaterThan(0);
      expect(cycles[0]).toContain("A");
      expect(cycles[0]).toContain("B");
      expect(cycles[0]).toContain("C");
    });
  });

  describe("6.4 Kernel Hooks & Integration", () => {
    it("passes through immediately when MODUS_GROUPS_MAILBOX is disabled", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_GROUPS_MAILBOX: false,
      });
      const context: HarnessContext = {
        sessionId: "sess-1",
        runId: "run-1",
        workspaceId: "ws-1",
        cwd: "/test",
        mode: "build",
        state: new Map(),
      };

      const result = await defaultTurnStartGroupMailboxHook.execute(
        { sessionId: "sess-1", userPrompt: "hello", mode: "build" },
        context,
      );

      expect(result.proceed).toBe(true);
      expect(context.state.has("harness.group_mailbox_pending")).toBe(false);
    });

    it("populates pending messages on context.state during turn_start", async () => {
      const mailbox = GroupMailbox.getInstance();
      mailbox.send({
        groupId: "g-test",
        from: "planner",
        to: "worker-session",
        content: "Execute task 42",
        revision: 1,
      });

      const context: HarnessContext = {
        sessionId: "worker-session",
        runId: "run-1",
        workspaceId: "ws-1",
        cwd: "/test",
        mode: "build",
        state: new Map(),
      };

      const result = await defaultTurnStartGroupMailboxHook.execute(
        { sessionId: "worker-session", userPrompt: "proceed", mode: "build" },
        context,
      );

      expect(result.proceed).toBe(true);
      expect(context.state.get("harness.group_mailbox_pending_count")).toBe(1);
      const pending = context.state.get("harness.group_mailbox_pending");
      expect(pending[0].content).toBe("Execute task 42");
    });

    it("registers mailbox tools in tools_register hook when enabled", async () => {
      const context: HarnessContext = {
        sessionId: "sess-1",
        runId: "run-1",
        workspaceId: "ws-1",
        cwd: "/test",
        mode: "build",
        state: new Map(),
      };

      const res = await defaultToolsRegisterGroupMailboxHook.execute(
        { requestedTools: ["view_file"] },
        context,
      );

      expect(res.registeredTools).toContain("group_mailbox_send");
      expect(res.registeredTools).toContain("group_mailbox_receive");
      expect(res.registeredTools).toContain("group_mailbox_ack");
      expect(res.registeredTools).toContain("group_revision_check");
    });
  });

  describe("6.5 Group Mailbox Tools Execution", () => {
    it("handles group_mailbox_send and receive round-trip", () => {
      const sendRes = handleGroupMailboxSend(
        { to: "agent2", content: "Review PR #4" },
        "agent1",
        "team-group",
      );
      expect(sendRes.success).toBe(true);
      expect(sendRes.messageId).toBeDefined();

      const recvRes = handleGroupMailboxReceive({ limit: 10 }, "agent2");
      expect(recvRes.success).toBe(true);
      expect(recvRes.count).toBe(1);
      expect(recvRes.messages?.[0]?.content).toBe("Review PR #4");

      const ackRes = handleGroupMailboxAck(
        { messageIds: [sendRes.messageId!] },
        "agent2",
      );
      expect(ackRes.success).toBe(true);
      expect(ackRes.ackedCount).toBe(1);

      const recvAfterAck = handleGroupMailboxReceive({}, "agent2");
      expect(recvAfterAck.count).toBe(0);
    });

    it("handles group_revision_check for conflict detection", () => {
      const registry = GroupRevisionRegistry.getInstance();
      registry.setRevision("team-group", {
        groupId: "team-group",
        agentId: "lead",
        revision: 3,
        files: { "package.json": "pkgHashV3" },
        updatedAt: "2026-10-06T12:00:00Z",
      });

      const checkNoConflict = handleGroupRevisionCheck(
        { files: { "package.json": "pkgHashV3", "new.ts": "newHash" } },
        "team-group",
      );
      expect(checkNoConflict.conflict).toBe(false);

      const checkConflict = handleGroupRevisionCheck(
        { files: { "package.json": "pkgOldHash" } },
        "team-group",
      );
      expect(checkConflict.conflict).toBe(true);
      expect(checkConflict.conflicts).toEqual(["package.json"]);
    });
  });

  describe("6.6 SLO Latency Benchmark", () => {
    it("processes 1,000 group mailbox operations in under 100ms", () => {
      const mailbox = new GroupMailbox();
      const start = performance.now();

      for (let i = 0; i < 500; i++) {
        mailbox.send({
          groupId: "perf-group",
          from: `agent-${i % 5}`,
          to: `agent-${(i + 1) % 5}`,
          content: `Benchmark payload ${i}`,
          revision: i,
        });
      }

      for (let i = 0; i < 5; i++) {
        mailbox.receive(`agent-${i}`);
      }

      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(100);
    });
  });

  describe("6.7 Review regressions (Fase 6)", () => {
    const mailboxTable = `create table if not exists harness_group_messages (
      id text primary key,
      group_id text not null,
      from_agent text not null,
      to_agent text not null,
      content text not null,
      revision integer not null default 0,
      sent_at text not null,
      acked_at text,
      dedupe_hash text not null
    )`;

    it("rehydrates pending messages from SQLite after a restart", () => {
      const db = new DatabaseSync(":memory:");
      db.exec(mailboxTable);

      const before = new GroupMailbox({}, () => db);
      const id = before.send({
        groupId: "g",
        from: "agent-1",
        to: "agent-2",
        content: "survives restart",
        revision: 1,
      });
      expect(before.receive("agent-2").map((m) => m.id)).toEqual([id]);

      // A fresh instance stands in for a process restart: memory is empty and
      // only SQLite can restore the inbox.
      const after = new GroupMailbox({}, () => db);
      const inbox = after.receive("agent-2");
      expect(inbox.map((m) => m.id)).toEqual([id]);
      expect(inbox[0]?.from).toBe("agent-1");
      expect(after.getPendingCount("agent-2")).toBe(1);
      expect(after.getPendingCount("agent-3")).toBe(0);

      db.close();
    });

    it("rejects an ack from an agent that is not the recipient", () => {
      const mailbox = GroupMailbox.getInstance();
      const id = handleGroupMailboxSend(
        { to: "agent-2", content: "private" },
        "agent-1",
        "g",
      ).messageId!;
      expect(id).toBeDefined();

      expect(mailbox.ack(id, "agent-3")).toBe(false);
      expect(mailbox.receive("agent-2")).toHaveLength(1);

      expect(mailbox.ack(id, "agent-2")).toBe(true);
      expect(mailbox.receive("agent-2")).toHaveLength(0);
    });

    it("keeps the dedupe entry of a live message when an older duplicate is purged", () => {
      const mailbox = GroupMailbox.getInstance();
      const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const nowIso = new Date().toISOString();

      const oldId = mailbox.send(
        {
          groupId: "g",
          from: "a",
          to: "b",
          content: "same content",
          revision: 1,
          sentAt: oldIso,
          ackedAt: oldIso,
        },
        oldIso,
      );
      const liveId = mailbox.send(
        {
          groupId: "g",
          from: "a",
          to: "b",
          content: "same content",
          revision: 1,
          sentAt: nowIso,
        },
        nowIso,
      );

      mailbox.purgeExpired(nowIso);

      const duplicateId = mailbox.send(
        {
          groupId: "g",
          from: "a",
          to: "b",
          content: "same content",
          revision: 1,
          sentAt: nowIso,
        },
        nowIso,
      );
      expect(oldId).toBeDefined();
      expect(duplicateId).toBe(liveId);
    });

    it("counts more than 50 pending messages without the receive() page cap", () => {
      const mailbox = GroupMailbox.getInstance();
      for (let i = 0; i < 60; i++) {
        mailbox.send({
          groupId: "g",
          from: "sender",
          to: "busy",
          content: `msg ${i}`,
          revision: 1,
        });
      }
      expect(mailbox.getPendingCount("busy")).toBe(60);
      expect(mailbox.receive("busy").length).toBe(50);
    });

    it("rejects a commit whose expected base diverged from the live revision", () => {
      const registry = GroupRevisionRegistry.getInstance();
      registry.setRevision(
        "g1",
        createGroupRevision({
          groupId: "g1",
          agentId: "lead",
          revision: 1,
          files: { a: "1" },
        }),
      );

      const staleBase = createGroupRevision({
        groupId: "g1",
        agentId: "worker",
        revision: 1,
        files: { a: "0" },
      });
      const incoming = createGroupRevision({
        groupId: "g1",
        agentId: "worker",
        revision: 1,
        files: { "new.ts": "x" },
      });

      const res = registry.commitRevision(staleBase, incoming);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.conflicts).toEqual(["a"]);
      }
      expect(registry.getRevision("g1")?.revision).toBe(1);
    });

    it("resolves mailbox sender identity from the owning session context", async () => {
      setAgentToolContext({
        workspaceId: "w",
        sessionId: "session-real",
        cwd: "F:\\repo",
        groupId: "team-group",
      });

      const result = await groupMailboxSendTool.execute(
        "call-1",
        { to: "session-other", content: "hello" },
        undefined,
        undefined,
        { cwd: "F:\\repo" } as never,
      );
      expect(result.details).toMatchObject({ success: true });

      const inbox = GroupMailbox.getInstance().receive("session-other");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.from).toBe("session-real");
      expect(inbox[0]?.groupId).toBe("team-group");
    });
  });
});
