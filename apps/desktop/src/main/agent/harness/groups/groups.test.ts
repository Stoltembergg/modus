import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentGroupStore from "../../../groups/group-store";
import {
  groupMailboxAckTool,
  groupMailboxReceiveTool,
  groupMailboxSendTool,
  groupRevisionCheckTool,
  handleGroupMailboxAck,
  handleGroupMailboxReceive,
  handleGroupMailboxSend,
  handleGroupRevisionCheck,
} from "../../tools/group-mailbox-tools";
import { setAgentToolContext } from "../../tools/tool-context";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import {
  canProceed,
  detectDependencyCycles,
  detectWriteConflict,
  findEligibleTasks,
  type GroupTaskDependencies,
  normalizeScope,
  scopesOverlap,
} from "./group-dependencies";
import { GroupMailbox } from "./group-mailbox";
import {
  advanceRevision,
  computeFileHash,
  createGroupRevision,
  detectConflict,
  detectThreeWayConflict,
  type GroupRevision,
  GroupRevisionRegistry,
} from "./group-revision";

const mailboxTestSchema = `
  create table harness_group_messages (
    id text primary key,
    group_id text not null,
    from_agent text not null,
    to_agent text not null,
    content text not null,
    revision integer not null default 0,
    sent_at text not null,
    acked_at text,
    dedupe_hash text not null
  );
  create table harness_group_message_acks (
    message_id text not null references harness_group_messages(id) on delete cascade,
    agent_id text not null,
    acked_at text not null,
    primary key (message_id, agent_id)
  );
  create index idx_harness_group_messages_to_ack on harness_group_messages(to_agent, acked_at, sent_at);
  create index idx_harness_group_messages_group on harness_group_messages(group_id, sent_at);
  create index idx_harness_group_messages_recipient_capacity on harness_group_messages(group_id, to_agent, sent_at);
  create index idx_harness_group_messages_group_ack on harness_group_messages(group_id, acked_at);
  create index idx_harness_group_messages_ack_expiry on harness_group_messages(acked_at) where acked_at is not null;
  create index idx_harness_group_messages_unack_expiry on harness_group_messages(sent_at) where acked_at is null;
  create index idx_harness_group_messages_dedupe on harness_group_messages(dedupe_hash, sent_at);`;

const mailboxTestDatabases: DatabaseSync[] = [];

function createMailboxTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(mailboxTestSchema);
  mailboxTestDatabases.push(db);
  return db;
}

function createTestMailbox(config: Partial<ConstructorParameters<typeof GroupMailbox>[0]> = {}) {
  const db = createMailboxTestDatabase();
  return new GroupMailbox(config, () => db);
}

function installTestMailbox(
  config: Partial<ConstructorParameters<typeof GroupMailbox>[0]> = {},
): GroupMailbox {
  const db = createMailboxTestDatabase();
  return GroupMailbox.getInstance(config, () => db);
}

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
    vi.restoreAllMocks();
    resetFeatureFlagOverrides();
    GroupMailbox.resetInstance();
    GroupRevisionRegistry.resetInstance();
    for (const db of mailboxTestDatabases.splice(0)) db.close();
  });

  describe("6.1 Group Mailbox Durability & Lifecycle", () => {
    it("sends and receives 1-to-1 direct messages", () => {
      const mailbox = installTestMailbox();
      const id1 = mailbox.send({
        groupId: "g1",
        from: "agentA",
        to: "agentB",
        content: "Hello Agent B",
        revision: 1,
        sentAt: "2026-10-06T12:00:00Z",
      });

      expect(typeof id1).toBe("string");
      expect(mailbox.getPendingCount("agentB", "g1")).toBe(1);
      expect(mailbox.getPendingCount("agentA", "g1")).toBe(0);

      const msgs = mailbox.receive("agentB", 50, "g1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.content).toBe("Hello Agent B");
      expect(msgs[0]?.from).toBe("agentA");
    });

    it("supports broadcast messages with independent per-agent acks", () => {
      const mailbox = installTestMailbox();
      const bcastId = mailbox.send({
        groupId: "g1",
        from: "coordinator",
        to: "*",
        content: "Global sync required",
        revision: 2,
        sentAt: "2026-10-06T12:00:00Z",
      });

      // Both agentA and agentB see the broadcast, but sender does not
      expect(mailbox.receive("agentA", 50, "g1")).toHaveLength(1);
      expect(mailbox.receive("agentB", 50, "g1")).toHaveLength(1);
      expect(mailbox.receive("coordinator", 50, "g1")).toHaveLength(0);

      // AgentA acks
      mailbox.ack(bcastId, "agentA", undefined, "g1");
      expect(mailbox.receive("agentA", 50, "g1")).toHaveLength(0);
      expect(mailbox.receive("agentB", 50, "g1")).toHaveLength(1);

      // AgentB acks
      mailbox.ack(bcastId, "agentB", undefined, "g1");
      expect(mailbox.receive("agentB", 50, "g1")).toHaveLength(0);
    });

    it("performs idempotent deduplication within 24h dedupe window", () => {
      const mailbox = installTestMailbox();
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
      expect(mailbox.receive("agentB", 50, "g1")).toHaveLength(1);
    });

    it("does not merge distinct recipient/content tuples that contain separators", () => {
      const mailbox = createTestMailbox();
      const broadcastId = mailbox.send({
        groupId: "g",
        from: "sender",
        to: "*",
        content: "x:y",
        revision: 1,
      });
      const directId = mailbox.send({
        groupId: "g",
        from: "sender",
        to: "*:x",
        content: "y",
        revision: 1,
      });

      expect(directId).not.toBe(broadcastId);
      expect(mailbox.getMessages("*:x", "g").map((message) => message.content)).toContain("y");
    });

    it("allows duplicate after 24h dedupe window expires", () => {
      const mailbox = installTestMailbox({ dedupeWindowMs: 3600_000 }); // 1h
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
      const mailbox = createTestMailbox({ maxMessagesPerAgent: 3 });
      mailbox.send({ groupId: "g", from: "A", to: "B", content: "m1", revision: 1 });
      mailbox.send({ groupId: "g", from: "A", to: "B", content: "m2", revision: 2 });
      mailbox.send({ groupId: "g", from: "A", to: "B", content: "m3", revision: 3 });
      mailbox.send({ groupId: "g", from: "A", to: "B", content: "m4", revision: 4 });

      const msgs = mailbox.receive("B", 50, "g");
      expect(msgs).toHaveLength(3);
      expect(msgs.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);
    });

    it("purges expired messages according to 7-day ack and 30-day unack policies", () => {
      const mailbox = createTestMailbox();
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
      mailbox.ack(id1, "B", new Date(baseTime - 8 * dayMs).toISOString(), "g");

      // 2. Acked message from 2 days ago (should keep)
      const id2 = mailbox.send({
        groupId: "g",
        from: "A",
        to: "B",
        content: "acked recent",
        revision: 1,
        sentAt: new Date(baseTime - 3 * dayMs).toISOString(),
      });
      mailbox.ack(id2, "B", new Date(baseTime - 2 * dayMs).toISOString(), "g");

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

      const remaining = mailbox.getMessages("B", "g");
      expect(remaining.map((m) => m.content)).toEqual(["unacked recent", "acked recent"]);
    });

    it("does not return expired persisted messages before the scheduled cleanup", () => {
      const db = createMailboxTestDatabase();
      const mailbox = new GroupMailbox(
        { ackRetentionMs: 1_000, unackRetentionMs: 1_000 },
        () => db,
      );
      const expiredAt = new Date(Date.now() - 2_000).toISOString();
      const insert = db.prepare(
        `insert into harness_group_messages
         (id, group_id, from_agent, to_agent, content, revision, sent_at, acked_at, dedupe_hash)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run("expired-unacked", "g", "sender", "recipient", "old", 1, expiredAt, null, "old-u");
      insert.run(
        "expired-acked",
        "g",
        "sender",
        "recipient",
        "old acked",
        1,
        expiredAt,
        expiredAt,
        "old-a",
      );

      expect(mailbox.receive("recipient", 50, "g")).toEqual([]);
      expect(mailbox.getMessages("recipient", "g")).toEqual([]);
      expect(mailbox.getPendingCount("recipient", "g")).toBe(0);
      expect(
        (
          db.prepare("select count(*) as count from harness_group_messages").get() as {
            count: number;
          }
        ).count,
      ).toBe(0);
    });

    it("normalizes legacy inboxes to the configured capacity before reading or counting", () => {
      const db = createMailboxTestDatabase();
      const mailbox = new GroupMailbox({ maxMessagesPerAgent: 2 }, () => db);
      const insert = db.prepare(
        `insert into harness_group_messages
         (id, group_id, from_agent, to_agent, content, revision, sent_at, acked_at, dedupe_hash)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let index = 1; index <= 4; index++) {
        insert.run(
          `legacy-${index}`,
          "g",
          "sender",
          "recipient",
          `message-${index}`,
          1,
          new Date(Date.now() + index).toISOString(),
          null,
          `legacy-hash-${index}`,
        );
      }

      expect(mailbox.getPendingCount("recipient", "g")).toBe(2);
      expect(mailbox.receive("recipient", 50, "g").map((message) => message.content)).toEqual([
        "message-3",
        "message-4",
      ]);
      expect(
        (
          db.prepare("select count(*) as count from harness_group_messages").get() as {
            count: number;
          }
        ).count,
      ).toBe(2);
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

  describe("6.5 Group Mailbox Tools Execution", () => {
    it("handles group_mailbox_send and receive round-trip", () => {
      installTestMailbox();
      const sendRes = handleGroupMailboxSend(
        { to: "agent2", content: "Review PR #4" },
        "agent1",
        "team-group",
      );
      expect(sendRes.success).toBe(true);
      expect(sendRes.messageId).toBeDefined();

      const recvRes = handleGroupMailboxReceive({ limit: 10 }, "agent2", "team-group");
      expect(recvRes.success).toBe(true);
      expect(recvRes.count).toBe(1);
      expect(recvRes.messages?.[0]?.content).toBe("Review PR #4");

      const ackRes = handleGroupMailboxAck(
        { messageIds: [sendRes.messageId!] },
        "agent2",
        "team-group",
      );
      expect(ackRes.success).toBe(true);
      expect(ackRes.ackedCount).toBe(1);

      const recvAfterAck = handleGroupMailboxReceive({}, "agent2", "team-group");
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
      const mailbox = createTestMailbox();
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
        mailbox.receive(`agent-${i}`, 50, "perf-group");
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
    const mailboxAckTable = `create table if not exists harness_group_message_acks (
      message_id text not null references harness_group_messages(id) on delete cascade,
      agent_id text not null,
      acked_at text not null,
      primary key (message_id, agent_id)
    )`;

    it("rehydrates pending messages from SQLite after a restart", () => {
      const db = new DatabaseSync(":memory:");
      db.exec(mailboxTable);
      db.exec(mailboxAckTable);

      const before = new GroupMailbox({}, () => db);
      const id = before.send({
        groupId: "g",
        from: "agent-1",
        to: "agent-2",
        content: "survives restart",
        revision: 1,
      });
      expect(before.receive("agent-2", 50, "g").map((m) => m.id)).toEqual([id]);

      // A fresh instance stands in for a process restart: memory is empty and
      // only SQLite can restore the inbox.
      const after = new GroupMailbox({}, () => db);
      const inbox = after.receive("agent-2", 50, "g");
      expect(inbox.map((m) => m.id)).toEqual([id]);
      expect(inbox[0]?.from).toBe("agent-1");
      expect(after.getPendingCount("agent-2", "g")).toBe(1);
      expect(after.getPendingCount("agent-3", "g")).toBe(0);

      db.close();
    });

    it("persists broadcast acknowledgements independently per recipient", () => {
      const db = new DatabaseSync(":memory:");
      db.exec(mailboxTable);
      db.exec(mailboxAckTable);
      const before = new GroupMailbox({}, () => db);
      const id = before.send({
        groupId: "g",
        from: "lead",
        to: "*",
        content: "durable broadcast",
        revision: 1,
      });

      expect(before.ack(id, "agent-1", undefined, "g")).toBe(true);

      const after = new GroupMailbox({}, () => db);
      expect(after.receive("agent-1", 50, "g")).toHaveLength(0);
      expect(after.receive("agent-2", 50, "g").map((message) => message.id)).toEqual([id]);
      db.close();
    });

    it("applies the mailbox capacity to broadcasts as well as direct messages", () => {
      const mailbox = createTestMailbox({ maxMessagesPerAgent: 2 });
      for (const content of ["oldest", "middle", "newest"]) {
        mailbox.send({
          groupId: "capacity-group",
          from: "sender",
          to: "*",
          content,
          revision: 1,
        });
      }

      expect(mailbox.receive("member", 50, "capacity-group").map(({ content }) => content)).toEqual(
        ["middle", "newest"],
      );
      expect(mailbox.getMessages("member", "capacity-group")).toHaveLength(2);
    });

    it("rolls back every ACK in a batch when one durable ACK fails", () => {
      const db = new DatabaseSync(":memory:");
      db.exec(mailboxTable);
      db.exec(mailboxAckTable);
      const mailbox = new GroupMailbox({}, () => db);
      const firstId = mailbox.send({
        groupId: "ack-group",
        from: "lead",
        to: "*",
        content: "first",
        revision: 1,
      });
      const secondId = mailbox.send({
        groupId: "ack-group",
        from: "lead",
        to: "*",
        content: "second",
        revision: 1,
      });
      db.exec(`create trigger fail_second_mailbox_ack before insert on harness_group_message_acks
        when new.message_id = '${secondId}'
        begin select raise(abort, 'injected ACK failure'); end`);

      const result = handleGroupMailboxAck(
        { messageIds: [firstId, secondId] },
        "member",
        "ack-group",
      );

      expect(result).toMatchObject({ success: false, ackedCount: 0 });
      expect(mailbox.receive("member", 50, "ack-group").map(({ id }) => id)).toEqual([
        firstId,
        secondId,
      ]);
      db.close();
    });

    it("scopes broadcast receive and ack to the host-provided group", () => {
      const db = new DatabaseSync(":memory:");
      db.exec(mailboxTable);
      db.exec(mailboxAckTable);
      const mailbox = new GroupMailbox({}, () => db);
      const groupAId = mailbox.send({
        groupId: "group-a",
        from: "lead-a",
        to: "*",
        content: "group a only",
        revision: 1,
      });
      const groupBId = mailbox.send({
        groupId: "group-b",
        from: "lead-b",
        to: "*",
        content: "group b only",
        revision: 1,
      });

      expect(mailbox.receive("member", 50, "group-a").map((message) => message.id)).toEqual([
        groupAId,
      ]);
      expect(mailbox.ack(groupAId, "member", undefined, "group-b")).toBe(false);
      expect(mailbox.receive("member", 50, "group-b").map((message) => message.id)).toEqual([
        groupBId,
      ]);
      db.close();
    });

    it("fails closed when mailbox access has no group scope", () => {
      const mailbox = createTestMailbox();
      const directId = mailbox.send({
        groupId: "private-group",
        from: "member-a",
        to: "member-b",
        content: "private direct message",
        revision: 1,
      });
      mailbox.send({
        groupId: "private-group",
        from: "member-a",
        to: "*",
        content: "private broadcast",
        revision: 1,
      });

      expect(mailbox.receive("member-b")).toEqual([]);
      expect(mailbox.getPendingCount("member-b")).toBe(0);
      expect(mailbox.getMessages("member-b")).toEqual([]);
      expect(mailbox.ack(directId, "member-b")).toBe(false);
      expect(mailbox.receive("member-b", 50, "private-group")).toHaveLength(2);
    });

    it("rejects a model-supplied mailbox group that differs from the host session", () => {
      expect(
        handleGroupMailboxSend(
          { to: "agent-2", content: "cross-group attempt", groupId: "other-group" },
          "agent-1",
          "owned-group",
        ),
      ).toMatchObject({ success: false });
    });

    it("fails closed when exported mailbox helpers have no host-assigned group", () => {
      const mailbox = installTestMailbox();
      expect(
        handleGroupMailboxSend({ to: "agent-2", content: "unscoped" }, "agent-1"),
      ).toMatchObject({ success: false });
      expect(mailbox.getMessages("agent-2", "default")).toEqual([]);
      expect(() => handleGroupRevisionCheck({ files: {} })).toThrow(/host-assigned.*group/i);
    });

    it("does not report success when an ACK is outside the session group", () => {
      const mailbox = installTestMailbox();
      const id = mailbox.send({
        groupId: "group-a",
        from: "lead",
        to: "*",
        content: "group scoped ack",
        revision: 1,
      });

      expect(handleGroupMailboxAck({ messageIds: [id] }, "member", "group-b")).toMatchObject({
        success: false,
        ackedCount: 0,
      });
      expect(mailbox.receive("member", 50, "group-a")).toHaveLength(1);
    });

    it("reports SQLite unavailability through the mailbox tool handlers", () => {
      GroupMailbox.getInstance({}, () => {
        throw new Error("SQLite unavailable");
      });

      expect(
        handleGroupMailboxSend({ to: "agent-2", content: "message" }, "agent-1", "g"),
      ).toMatchObject({ success: false });
      expect(handleGroupMailboxReceive({}, "agent-2", "g")).toMatchObject({ success: false });
      expect(handleGroupMailboxAck({ messageIds: ["unknown"] }, "agent-2", "g")).toMatchObject({
        success: false,
      });
    });

    it("does not report a direct acknowledgement when SQLite rejects it", () => {
      const db = new DatabaseSync(":memory:");
      db.exec(mailboxTable);
      db.exec(mailboxAckTable);
      const mailbox = new GroupMailbox({}, () => db);
      const id = mailbox.send({
        groupId: "g",
        from: "agent-1",
        to: "agent-2",
        content: "ack must persist",
        revision: 1,
      });
      db.exec(`create trigger fail_mailbox_ack before update of acked_at on harness_group_messages
        begin select raise(abort, 'injected ack persistence failure'); end`);

      expect(() => mailbox.ack(id, "agent-2", undefined, "g")).toThrow(/persist/i);
      expect(mailbox.receive("agent-2", 50, "g").map((message) => message.id)).toEqual([id]);
      db.close();
    });

    it("rejects acknowledgements for messages that already exceeded their retention", () => {
      const db = createMailboxTestDatabase();
      const mailbox = new GroupMailbox(
        { ackRetentionMs: 1_000, unackRetentionMs: 1_000 },
        () => db,
      );
      const expiredAt = new Date(Date.now() - 2_000).toISOString();
      const insert = db.prepare(
        `insert into harness_group_messages
         (id, group_id, from_agent, to_agent, content, revision, sent_at, acked_at, dedupe_hash)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run("expired-direct", "g", "sender", "recipient", "old", 1, expiredAt, null, "old-d");
      insert.run("expired-broadcast", "g", "sender", "*", "old", 1, expiredAt, null, "old-b");

      expect(mailbox.ack("expired-direct", "recipient", undefined, "g")).toBe(false);
      expect(mailbox.ack("expired-broadcast", "recipient", undefined, "g")).toBe(false);
      const directMessage = db
        .prepare("select acked_at from harness_group_messages where id = ?")
        .get("expired-direct") as { acked_at: string | null } | undefined;
      expect(directMessage?.acked_at).toBeNull();
      expect(
        (
          db.prepare("select count(*) as count from harness_group_message_acks").get() as {
            count: number;
          }
        ).count,
      ).toBe(0);
    });

    it("does not open a write transaction for a clean scoped inbox read", () => {
      const db = createMailboxTestDatabase();
      let immediateTransactions = 0;
      const instrumentedDb = new Proxy(db, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "exec") {
            return (sql: string) => {
              if (sql.toLowerCase().includes("begin immediate")) immediateTransactions++;
              return Reflect.apply(value, target, [sql]);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DatabaseSync;
      const mailbox = new GroupMailbox({}, () => instrumentedDb);
      mailbox.send({
        groupId: "g",
        from: "sender",
        to: "recipient",
        content: "current",
        revision: 1,
      });
      immediateTransactions = 0;

      expect(mailbox.getPendingCount("recipient", "g")).toBe(1);
      expect(immediateTransactions).toBe(0);
    });

    it("does not open a global write transaction when no messages have expired", () => {
      const db = createMailboxTestDatabase();
      let immediateTransactions = 0;
      const instrumentedDb = new Proxy(db, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "exec") {
            return (sql: string) => {
              if (sql.toLowerCase().includes("begin immediate")) immediateTransactions++;
              return Reflect.apply(value, target, [sql]);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DatabaseSync;
      const mailbox = new GroupMailbox({}, () => instrumentedDb);
      mailbox.send({
        groupId: "g",
        from: "sender",
        to: "recipient",
        content: "current",
        revision: 1,
      });
      immediateTransactions = 0;

      expect(mailbox.purgeExpired()).toBe(0);
      expect(immediateTransactions).toBe(0);
    });

    it("caps legacy inboxes beyond the former 20,000-row hydration limit", () => {
      const db = new DatabaseSync(":memory:");
      db.exec(mailboxTable);
      db.exec(mailboxAckTable);
      db.exec(`
        with recursive seq(n) as (
          select 1 union all select n + 1 from seq where n < 20005
        )
        insert into harness_group_messages
          (id, group_id, from_agent, to_agent, content, revision, sent_at, acked_at, dedupe_hash)
        select 'message-' || n, 'g', 'sender', 'recipient', 'payload-' || n, 1,
               '2026-10-10T00:00:00.000Z', null, 'hash-' || n
        from seq
      `);
      const mailbox = new GroupMailbox({}, () => db);

      expect(mailbox.receive("recipient", 50, "g")).toHaveLength(50);
      expect(mailbox.getPendingCount("recipient", "g")).toBe(1000);
      expect(
        (
          db.prepare("select count(*) as count from harness_group_messages").get() as {
            count: number;
          }
        ).count,
      ).toBe(1000);
      db.close();
    });

    it("rejects a send when durable persistence is unavailable", () => {
      const mailbox = new GroupMailbox({}, () => {
        throw new Error("SQLite unavailable");
      });

      expect(() =>
        mailbox.send({
          groupId: "g",
          from: "agent-1",
          to: "agent-2",
          content: "must not be memory-only success",
          revision: 1,
        }),
      ).toThrow(/durable/i);
      expect(() => mailbox.receive("agent-2", 50, "g")).toThrow(/durable/i);
    });

    it("rolls back a failed SQLite send without storing or reporting the message", () => {
      const db = new DatabaseSync(":memory:");
      db.exec(mailboxTable);
      db.exec(mailboxAckTable);
      db.exec(`create trigger fail_mailbox_send before insert on harness_group_messages
        begin select raise(abort, 'injected send persistence failure'); end`);
      const mailbox = new GroupMailbox({}, () => db);

      expect(() =>
        mailbox.send({
          groupId: "g",
          from: "agent-1",
          to: "agent-2",
          content: "transaction must roll back",
          revision: 1,
        }),
      ).toThrow(/durable persistence/i);
      expect(
        (
          db.prepare("select count(*) as count from harness_group_messages").get() as {
            count: number;
          }
        ).count,
      ).toBe(0);
      db.close();
    });

    it("rejects an ack from an agent that is not the recipient", () => {
      const mailbox = installTestMailbox();
      const id = handleGroupMailboxSend({ to: "agent-2", content: "private" }, "agent-1", "g")
        .messageId!;
      expect(id).toBeDefined();

      expect(mailbox.ack(id, "agent-3", undefined, "g")).toBe(false);
      expect(mailbox.receive("agent-2", 50, "g")).toHaveLength(1);

      expect(mailbox.ack(id, "agent-2", undefined, "g")).toBe(true);
      expect(mailbox.receive("agent-2", 50, "g")).toHaveLength(0);
    });

    it("keeps the dedupe entry of a live message when an older duplicate is purged", () => {
      const mailbox = installTestMailbox();
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
      const mailbox = installTestMailbox();
      for (let i = 0; i < 60; i++) {
        mailbox.send({
          groupId: "g",
          from: "sender",
          to: "busy",
          content: `msg ${i}`,
          revision: 1,
        });
      }
      expect(mailbox.getPendingCount("busy", "g")).toBe(60);
      expect(mailbox.receive("busy", 50, "g").length).toBe(50);
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
      const mailbox = installTestMailbox();
      vi.spyOn(agentGroupStore, "getAgentGroupForSession").mockImplementation(
        (sessionId) =>
          ({ id: sessionId === "session-foreign" ? "other-group" : "team-group" }) as never,
      );
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

      setAgentToolContext({
        workspaceId: "w",
        sessionId: "session-other",
        cwd: "F:\\repo",
        groupId: "team-group",
      });
      const received = await groupMailboxReceiveTool.execute("call-2", {}, undefined, undefined, {
        cwd: "F:\\repo",
      } as never);
      expect(received.details).toMatchObject({ success: true, count: 1 });

      const receivedDetails = received.details as { messages: { id: string }[] };
      const messageId = receivedDetails.messages[0]?.id;
      expect(messageId).toBeDefined();
      if (!messageId) throw new Error("Expected the production mailbox tool to return a message.");
      const acked = await groupMailboxAckTool.execute(
        "call-3",
        { message_ids: [messageId] },
        undefined,
        undefined,
        { cwd: "F:\\repo" } as never,
      );
      expect(acked.details).toMatchObject({ success: true, ackedCount: 1 });
      expect(mailbox.receive("session-other", 50, "team-group")).toHaveLength(0);

      setAgentToolContext({
        workspaceId: "w",
        sessionId: "session-foreign",
        cwd: "F:\\repo",
        groupId: "other-group",
      });
      const foreignInbox = await groupMailboxReceiveTool.execute(
        "call-4",
        {},
        undefined,
        undefined,
        { cwd: "F:\\repo" } as never,
      );
      expect(foreignInbox.details).toMatchObject({ success: true, count: 0 });

      const inbox = mailbox.getMessages("session-other", "team-group");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.from).toBe("session-real");
      expect(inbox[0]?.groupId).toBe("team-group");
    });

    it("rejects mailbox reads from an owning session without a group", async () => {
      installTestMailbox().send({
        groupId: "private-group",
        from: "member",
        to: "ungrouped-session",
        content: "private",
        revision: 1,
      });
      setAgentToolContext({
        workspaceId: "w",
        sessionId: "ungrouped-session",
        cwd: "F:\\repo",
      });

      const result = await groupMailboxReceiveTool.execute(
        "call-ungrouped",
        {},
        undefined,
        undefined,
        { cwd: "F:\\repo" } as never,
      );

      expect(result.details).toMatchObject({ success: false });
    });

    it("uses the host group for revision checks instead of a model-supplied group", async () => {
      const revisions = GroupRevisionRegistry.getInstance();
      revisions.setRevision("trusted-group", {
        groupId: "trusted-group",
        agentId: "lead",
        revision: 2,
        files: { "src/a.ts": "trusted-hash" },
        updatedAt: new Date().toISOString(),
      });
      revisions.setRevision("foreign-group", {
        groupId: "foreign-group",
        agentId: "lead",
        revision: 7,
        files: { "src/a.ts": "foreign-hash" },
        updatedAt: new Date().toISOString(),
      });
      vi.spyOn(agentGroupStore, "getAgentGroupForSession").mockImplementation((sessionId) =>
        sessionId === "trusted-member" ? ({ id: "trusted-group" } as never) : undefined,
      );
      setAgentToolContext({
        workspaceId: "w",
        sessionId: "trusted-member",
        cwd: "F:\\repo",
        groupId: "trusted-group",
      });

      const result = await groupRevisionCheckTool.execute(
        "call-revision",
        { files: { "src/a.ts": "foreign-hash" }, group_id: "foreign-group" } as never,
        undefined,
        undefined,
        { cwd: "F:\\repo" } as never,
      );

      expect(result.details).toMatchObject({ conflict: true, currentRevision: 2 });
    });
  });
});
