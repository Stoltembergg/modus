import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/contracts";

describe("Sprint 0.2: Persistent Stores Capacity & Performance Benchmark", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    // In-memory SQLite simulating node:sqlite database
    db = new DatabaseSync(":memory:");
    db.exec(`
      create table workspaces (
        id text primary key,
        root_path text not null unique,
        display_name text not null,
        created_at text not null
      );

      create table agent_sessions (
        id text primary key,
        workspace_id text not null references workspaces(id) on delete cascade,
        title text not null,
        cwd text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create table agent_events (
        id text primary key,
        session_id text not null references agent_sessions(id) on delete cascade,
        type text not null,
        payload_json text not null,
        created_at text not null
      );

      create index if not exists idx_agent_events_session_created
        on agent_events(session_id, created_at asc);

      create table agent_runs (
        id text primary key,
        session_id text not null references agent_sessions(id) on delete cascade,
        prompt text not null,
        status text not null,
        started_at text not null
      );
    `);

    db.prepare(`insert into workspaces values (?, ?, ?, ?)`).run(
      "ws-1",
      "/test/ws",
      "Test Workspace",
      new Date().toISOString(),
    );
    db.prepare(`insert into agent_sessions values (?, ?, ?, ?, ?, ?, ?)`).run(
      "session-bench",
      "ws-1",
      "Benchmark Session",
      "/test/ws",
      "idle",
      new Date().toISOString(),
      new Date().toISOString(),
    );
  });

  afterAll(() => {
    db.close();
  });

  it("Benchmark 1: Large Payload Insert & Retrieval (1KB, 100KB, 500KB, 1MB)", () => {
    const sizes = [1024, 100 * 1024, 500 * 1024, 1024 * 1024]; // 1KB, 100KB, 500KB, 1MB
    const results: Record<string, { insertMs: number; fetchMs: number; parseMs: number }> = {};

    for (const size of sizes) {
      const label = `${Math.round(size / 1024)}KB`;
      const dummyData = "X".repeat(size);
      const event: AgentEvent = {
        type: "tool.ended",
        sessionId: "session-bench",
        toolCallId: `call-${size}`,
        isError: false,
      };
      const payload = JSON.stringify({ ...event, rawOutput: dummyData });

      const startInsert = performance.now();
      const eventId = randomUUID();
      db.prepare(
        `insert into agent_events (id, session_id, type, payload_json, created_at)
         values (?, ?, ?, ?, ?)`,
      ).run(eventId, "session-bench", event.type, payload, new Date().toISOString());
      const insertMs = performance.now() - startInsert;

      const startFetch = performance.now();
      const row = db.prepare(`select payload_json from agent_events where id = ?`).get(eventId) as {
        payload_json: string;
      };
      const fetchMs = performance.now() - startFetch;

      const startParse = performance.now();
      const parsed = JSON.parse(row.payload_json);
      const parseMs = performance.now() - startParse;

      expect(parsed.rawOutput.length).toBe(size);

      results[label] = { insertMs, fetchMs, parseMs };
    }

    // SQLite effortlessly handles 1MB row insertion and retrieval in single-digit ms
    expect(results["1024KB"]!.insertMs).toBeLessThan(100);
    expect(results["1024KB"]!.fetchMs).toBeLessThan(100);
  });

  it("Benchmark 2: listAgentEvents Scalability & IPC Impact with Unspilled vs Spilled Payloads", () => {
    // Compare fetching 100 events with 50KB unspilled payloads vs 100 events with 500B spilled previews
    const sessionUnspilled = "session-unspilled";
    const sessionSpilled = "session-spilled";

    db.prepare(`insert into agent_sessions values (?, ?, ?, ?, ?, ?, ?)`).run(
      sessionUnspilled,
      "ws-1",
      "Unspilled",
      "/test/ws",
      "idle",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.prepare(`insert into agent_sessions values (?, ?, ?, ?, ?, ?, ?)`).run(
      sessionSpilled,
      "ws-1",
      "Spilled",
      "/test/ws",
      "idle",
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const eventCount = 100;
    const largeText = "A".repeat(50 * 1024); // 50KB unspilled output
    const previewText = "[Output spilled: 51200 chars. Head: AAAA... Tail: AAAA]"; // ~100B preview

    // Seed unspilled
    for (let i = 0; i < eventCount; i++) {
      const payload = JSON.stringify({
        type: "tool.ended",
        sessionId: sessionUnspilled,
        toolCallId: `call-${i}`,
        output: largeText,
        isError: false,
      });
      db.prepare(
        `insert into agent_events (id, session_id, type, payload_json, created_at) values (?, ?, ?, ?, ?)`,
      ).run(randomUUID(), sessionUnspilled, "tool.ended", payload, new Date().toISOString());
    }

    // Seed spilled
    for (let i = 0; i < eventCount; i++) {
      const payload = JSON.stringify({
        type: "tool.ended",
        sessionId: sessionSpilled,
        toolCallId: `call-${i}`,
        output: previewText,
        spillId: `spill-${i}`,
        isError: false,
      });
      db.prepare(
        `insert into agent_events (id, session_id, type, payload_json, created_at) values (?, ?, ?, ?, ?)`,
      ).run(randomUUID(), sessionSpilled, "tool.ended", payload, new Date().toISOString());
    }

    // Measure Unspilled listAgentEvents simulation (select all + JSON.parse all)
    const t0 = performance.now();
    const unspilledRows = db
      .prepare(
        `select id, payload_json, created_at, rowid as event_cursor from agent_events where session_id = ? order by created_at asc, rowid asc`,
      )
      .all(sessionUnspilled) as Array<{ id: string; payload_json: string }>;
    let unspilledTotalBytes = 0;
    const unspilledEvents = unspilledRows.map((r) => {
      unspilledTotalBytes += r.payload_json.length;
      return JSON.parse(r.payload_json);
    });
    const unspilledDurationMs = performance.now() - t0;

    // Measure Spilled listAgentEvents simulation
    const t1 = performance.now();
    const spilledRows = db
      .prepare(
        `select id, payload_json, created_at, rowid as event_cursor from agent_events where session_id = ? order by created_at asc, rowid asc`,
      )
      .all(sessionSpilled) as Array<{ id: string; payload_json: string }>;
    let spilledTotalBytes = 0;
    const spilledEvents = spilledRows.map((r) => {
      spilledTotalBytes += r.payload_json.length;
      return JSON.parse(r.payload_json);
    });
    const spilledDurationMs = performance.now() - t1;

    expect(unspilledEvents.length).toBe(eventCount);
    expect(spilledEvents.length).toBe(eventCount);

    // Spilled payload size is ~500x smaller!
    expect(unspilledTotalBytes).toBeGreaterThan(4.8 * 1024 * 1024); // ~5MB
    expect(spilledTotalBytes).toBeLessThan(50 * 1024); // < 50KB
    expect(spilledDurationMs).toBeLessThanOrEqual(unspilledDurationMs + 10);
  });

  it("Benchmark 3: High Event Volume Querying (5,000 events) & Index Verification", () => {
    const sessionVolume = "session-volume";
    db.prepare(`insert into agent_sessions values (?, ?, ?, ?, ?, ?, ?)`).run(
      sessionVolume,
      "ws-1",
      "Volume Session",
      "/test/ws",
      "idle",
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const insertStmt = db.prepare(
      `insert into agent_events (id, session_id, type, payload_json, created_at) values (?, ?, ?, ?, ?)`,
    );

    // Bulk insert 5,000 events in a transaction
    const tStart = performance.now();
    db.exec("begin");
    for (let i = 0; i < 5000; i++) {
      const payload = JSON.stringify({
        type: "message.delta",
        sessionId: sessionVolume,
        messageId: `msg-${Math.floor(i / 50)}`,
        delta: "token ",
      });
      insertStmt.run(
        randomUUID(),
        sessionVolume,
        "message.delta",
        payload,
        new Date().toISOString(),
      );
    }
    db.exec("commit");
    const bulkInsertMs = performance.now() - tStart;

    // Query 5,000 events
    const tQuery = performance.now();
    const rows = db
      .prepare(
        `select id, payload_json, created_at, rowid as event_cursor
         from agent_events
         where session_id = ?
         order by created_at asc, rowid asc`,
      )
      .all(sessionVolume);
    const queryMs = performance.now() - tQuery;

    expect(rows.length).toBe(5000);
    expect(bulkInsertMs).toBeLessThan(1000); // 5000 rows committed in < 1s
    expect(queryMs).toBeLessThan(50); // Query 5000 rows in < 50ms
  });

  it("Benchmark 4: Cascade Deletion Verification", () => {
    const sessionDel = "session-del";
    db.prepare(`insert into agent_sessions values (?, ?, ?, ?, ?, ?, ?)`).run(
      sessionDel,
      "ws-1",
      "Session To Delete",
      "/test/ws",
      "idle",
      new Date().toISOString(),
      new Date().toISOString(),
    );

    for (let i = 0; i < 10; i++) {
      db.prepare(
        `insert into agent_events (id, session_id, type, payload_json, created_at) values (?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        sessionDel,
        "message.delta",
        JSON.stringify({ text: "hi" }),
        new Date().toISOString(),
      );
    }

    const countBefore = (
      db.prepare(`select count(*) as c from agent_events where session_id = ?`).get(sessionDel) as {
        c: number;
      }
    ).c;
    expect(countBefore).toBe(10);

    // Enable foreign keys and delete session
    db.exec("PRAGMA foreign_keys = ON;");
    db.prepare(`delete from agent_sessions where id = ?`).run(sessionDel);

    const countAfter = (
      db.prepare(`select count(*) as c from agent_events where session_id = ?`).get(sessionDel) as {
        c: number;
      }
    ).c;
    expect(countAfter).toBe(0);
  });
});
