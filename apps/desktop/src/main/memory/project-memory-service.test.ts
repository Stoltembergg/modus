import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";
import { clearRun, registerMcpCitations } from "../agent/harness/mcp-citation-registry";

const { userDataPath } = vi.hoisted(() => ({ userDataPath: { current: "" } }));

vi.mock("electron", () => ({ app: { getPath: () => userDataPath.current } }));

let root: string;
let db: DatabaseSync;
let service: typeof import("./project-memory-service");

const MAX_TITLE_LENGTH = 160;
const MAX_CLAIM_LENGTH = 1200;
const MAX_EVIDENCE_COUNT = 32;
const MAX_EVIDENCE_STRING_LENGTH = 1024;
const MAX_EVIDENCE_DTO_COUNT = 32;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "modus-project-memory-"));
  userDataPath.current = join(root, "userData");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(userDataPath.current, { recursive: true });
  const seed = new DatabaseSync(join(userDataPath.current, "modus.sqlite"));
  seed.exec(`
    create table workspaces (id text primary key, root_path text not null unique, display_name text not null,
      is_git_repository integer not null default 0, last_opened_at text not null, created_at text not null);
    create table agent_sessions (id text primary key, workspace_id text not null references workspaces(id),
      title text not null, cwd text not null, status text not null, created_at text not null, updated_at text not null);
    insert into workspaces values ('ws-legacy', '/legacy', 'Legacy', 1, '2020', '2020');
    insert into agent_sessions values ('session-legacy', 'ws-legacy', 'Legacy chat', '/legacy', 'idle', '2020', '2020');
  `);
  seed.close();
  const { getDatabase } = await import("../db/database");
  db = getDatabase();
  db.prepare(
    "insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at) values (?, ?, ?, 0, ?, ?)",
  ).run("ws-b", "/b", "B", "now", "now");
  db.prepare(
    "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("session-legacy-b", "ws-b", "B chat", "/b", "idle", "now", "now");
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run("run-1", "session-legacy", "msg-1", "user prompt", "completed", "now");
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run(
    "run-replacement",
    "session-legacy",
    "msg-replacement",
    "replacement prompt",
    "completed",
    "now",
  );
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run("run-b", "session-legacy-b", "msg-b", "user prompt", "completed", "now");
  db.prepare(
    "insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at) values (?, ?, ?, 0, ?, ?)",
  ).run(CHATS_WORKSPACE_ID, "/inbox", "Inbox", "now", "now");
  db.prepare(
    "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("session-inbox", CHATS_WORKSPACE_ID, "Inbox chat", "/inbox", "idle", "now", "now");
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run("run-inbox", "session-inbox", "msg-inbox", "user prompt", "completed", "now");
  db.prepare(
    "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("session-dedupe", "ws-legacy", "Dedupe chat", "/legacy", "idle", "now", "now");
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run("run-dedupe-a", "session-dedupe", "msg-dedupe-a", "user prompt", "completed", "now");
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run("run-dedupe-b", "session-dedupe", "msg-dedupe-b", "user prompt", "completed", "now");
  db.prepare(`insert into agent_sessions (id, workspace_id, title, cwd, status, parent_session_id, subagent_worktree_path, subagent_integration_status, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "session-worktree",
    "ws-legacy",
    "Worktree child",
    "/legacy/.worktrees/child",
    "idle",
    "session-legacy",
    "/legacy/.worktrees/child",
    "running",
    "now",
    "now",
  );
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run("run-worktree", "session-worktree", "msg-worktree", "user prompt", "completed", "now");
  db.prepare(`insert into agent_sessions (id, workspace_id, title, cwd, status, parent_session_id, created_at, updated_at)
    values (?, ?, ?, ?, 'idle', ?, ?, ?)`).run(
    "session-shared-child",
    "ws-legacy",
    "Shared child",
    "/legacy",
    "session-legacy",
    "now",
    "now",
  );
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run(
    "run-shared-child",
    "session-shared-child",
    "subagent-user:synthetic-message",
    "child request",
    "running",
    "now",
  );
  db.prepare(
    "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("session-prior", "ws-legacy", "Prior state chat", "/legacy", "idle", "now", "now");
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run("run-prior", "session-prior", "msg-prior", "prompt", "completed", "now");
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run(
    "run-prior-replacement",
    "session-prior",
    "msg-prior-replacement",
    "prompt",
    "completed",
    "now",
  );
  db.prepare(
    "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "session-detached-prior",
    "ws-legacy",
    "Detached prior chat",
    "/legacy",
    "idle",
    "now",
    "now",
  );
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run(
    "run-detached-prior",
    "session-detached-prior",
    "msg-detached-prior",
    "prompt",
    "completed",
    "now",
  );
  db.prepare(
    "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("session-dto-evidence", "ws-legacy", "DTO evidence chat", "/legacy", "idle", "now", "now");
  db.prepare(
    "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
  ).run("run-dto-initial", "session-dto-evidence", "msg-dto-initial", "prompt", "completed", "now");
  service = await import("./project-memory-service");
});

afterAll(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("project memory migration", () => {
  it("preserves existing workspace and session rows and creates the memory schema", () => {
    expect(db.prepare("select id from workspaces where id = ?").get("ws-legacy")).toEqual({
      id: "ws-legacy",
    });
    expect(db.prepare("select id from agent_sessions where id = ?").get("session-legacy")).toEqual({
      id: "session-legacy",
    });
    const tables = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "project_memory_records",
        "project_memory_evidence",
        "project_memory_events",
        "project_memory_settings",
      ]),
    );
    const indexes = db
      .prepare("select name from sqlite_master where type = 'index'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_project_memory_workspace_status_verified",
        "idx_project_memory_scope_status_verified",
      ]),
    );
  });

  it("enforces valid global and project scope ownership in SQLite", () => {
    const insert = db.prepare(`insert into project_memory_records
      (id, scope, workspace_id, category, title, claim, status, verification, dedupe_key, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    expect(() =>
      insert.run(
        "bad-global",
        "global",
        "ws-legacy",
        "preference",
        "x",
        "x",
        "candidate",
        "unverified",
        "x",
        "now",
        "now",
      ),
    ).toThrow();
    expect(() =>
      insert.run(
        "bad-project",
        "project",
        null,
        "decision",
        "x",
        "x",
        "candidate",
        "unverified",
        "x",
        "now",
        "now",
      ),
    ).toThrow();
  });

  it("enforces one global settings row despite NULL workspace keys", () => {
    const insert = db.prepare(
      "insert into project_memory_settings(scope, workspace_id, enabled, updated_at) values ('global', null, 1, 'now')",
    );
    insert.run();
    expect(() => insert.run()).toThrow();
  });

  it("reruns the schema migration idempotently on a separate SQLite connection", async () => {
    const { migrateDatabase } = (await import(
      "../db/database"
    )) as typeof import("../db/database") & {
      migrateDatabase: (database: DatabaseSync) => void;
    };
    const isolated = new DatabaseSync(":memory:");
    try {
      isolated.exec("pragma foreign_keys = on");
      migrateDatabase(isolated);
      isolated
        .prepare(
          "insert into workspaces (id, root_path, display_name, last_opened_at, created_at) values (?, ?, ?, ?, ?)",
        )
        .run("rerun-ws", "/rerun", "Rerun", "now", "now");
      migrateDatabase(isolated);
      expect(isolated.prepare("select id from workspaces where id = ?").get("rerun-ws")).toEqual({
        id: "rerun-ws",
      });
      expect(
        isolated
          .prepare(
            "select count(*) as count from sqlite_master where type = 'table' and name like 'project_memory_%'",
          )
          .get(),
      ).toEqual({ count: 4 });
    } finally {
      isolated.close();
    }
  });

  it("transactionally rebuilds a populated legacy evidence table preserving IDs, indexes, FKs, and detach trigger", async () => {
    const { migrateDatabase } = await import("../db/database");
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(`pragma foreign_keys = on;
        create table workspaces(id text primary key, root_path text unique not null, display_name text not null, is_git_repository integer default 0, last_opened_at text not null, created_at text not null);
        create table agent_sessions(id text primary key, workspace_id text not null references workspaces(id), title text not null, cwd text not null, status text not null, created_at text not null, updated_at text not null);
        create table project_memory_records(id text primary key, scope text not null, workspace_id text references workspaces(id) on delete cascade, category text not null, title text not null, claim text not null, status text not null, verification text not null, created_at text not null, updated_at text not null, last_verified_at text, supersedes_id text, dedupe_key text not null);
        create table project_memory_evidence(id text primary key, memory_id text not null references project_memory_records(id) on delete cascade, kind text not null check(kind in ('user_message','run','task','subagent','commit','file','symbol')), session_id text references agent_sessions(id) on delete set null, run_id text, user_message_id text, task_ref text, commit_sha text, branch text, path text, symbol text, detached integer not null default 0 check(detached in (0,1)));
        create index idx_project_memory_evidence_memory on project_memory_evidence(memory_id);
        create index idx_project_memory_evidence_session on project_memory_evidence(session_id);
        insert into workspaces values ('legacy-ws','/legacy','Legacy',0,'now','now');
        insert into agent_sessions values ('legacy-session','legacy-ws','Legacy','/legacy','idle','now','now');
        insert into project_memory_records values ('legacy-memory','project','legacy-ws','decision','Title','Legacy claim','active','agent_observed','now','now',null,null,'dedupe');
        insert into project_memory_evidence(id,memory_id,kind,session_id,run_id,path) values ('legacy-evidence','legacy-memory','file','legacy-session','legacy-run','src/a.ts');`);
      migrateDatabase(legacy);
      expect(legacy.prepare("select id, kind, path from project_memory_evidence").get()).toEqual({
        id: "legacy-evidence",
        kind: "file",
        path: "src/a.ts",
      });
      expect(legacy.prepare("pragma foreign_key_check").all()).toEqual([]);
      expect(
        legacy
          .prepare(
            "select name from sqlite_master where type='index' and name like 'idx_project_memory_evidence_%' order by name",
          )
          .all(),
      ).toEqual([
        { name: "idx_project_memory_evidence_memory" },
        { name: "idx_project_memory_evidence_session" },
      ]);
      expect(
        legacy
          .prepare(
            "select count(*) as count from sqlite_master where type='trigger' and name='trg_detach_project_memory_before_session_delete'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(() =>
        legacy
          .prepare(
            `insert into project_memory_evidence(id,memory_id,kind) values ('external','legacy-memory','external_reference')`,
          )
          .run(),
      ).not.toThrow();
      migrateDatabase(legacy);
      expect(
        legacy
          .prepare(
            "select count(*) as count from project_memory_evidence where id='legacy-evidence'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      legacy.close();
    }
  });

  it("rolls back a failed legacy evidence rebuild without replacing the old table", async () => {
    const { migrateDatabase } = await import("../db/database");
    const broken = new DatabaseSync(":memory:");
    try {
      broken.exec(`pragma foreign_keys = off;
        create table workspaces(id text primary key, root_path text unique not null, display_name text not null, is_git_repository integer default 0, last_opened_at text not null, created_at text not null);
        create table agent_sessions(id text primary key, workspace_id text not null references workspaces(id), title text not null, cwd text not null, status text not null, created_at text not null, updated_at text not null);
        create table project_memory_records(id text primary key, scope text not null, workspace_id text, category text not null, title text not null, claim text not null, status text not null, verification text not null, created_at text not null, updated_at text not null, last_verified_at text, supersedes_id text, dedupe_key text not null);
        create table project_memory_evidence(id text primary key, memory_id text not null references project_memory_records(id) on delete cascade, kind text not null check(kind in ('user_message','run','task','subagent','commit','file','symbol')), session_id text references agent_sessions(id) on delete set null, run_id text, user_message_id text, task_ref text, commit_sha text, branch text, path text, symbol text, detached integer not null default 0 check(detached in (0,1)));
        insert into project_memory_records values ('broken-memory','project','missing-workspace','decision','Title','Claim','active','unverified','now','now',null,null,'dedupe');
        insert into project_memory_evidence(id,memory_id,kind,session_id) values ('broken-evidence','broken-memory','file','missing-session');
        pragma foreign_keys = on;`);
      expect(() => migrateDatabase(broken)).toThrow();
      expect(broken.prepare("select id from project_memory_evidence").get()).toEqual({
        id: "broken-evidence",
      });
      expect(
        (
          broken
            .prepare("select sql from sqlite_master where name='project_memory_evidence'")
            .get() as { sql: string }
        ).sql,
      ).toContain("'symbol'))");
    } finally {
      broken.close();
    }
  });
});

describe("project memory service", () => {
  const context = {
    workspaceId: "ws-legacy",
    sessionId: "session-legacy",
    runId: "run-1",
    userMessageId: "msg-1",
    cwd: "/legacy",
  };
  const proposal = (
    claim: string,
    scope: "global" | "project" = "project",
    category: "decision" | "preference" | "convention" = "decision",
    owner = context,
  ) => ({
    scope,
    category,
    title: claim.slice(0, 30),
    claim,
    evidence: [
      { kind: "run" as const, sessionId: owner.sessionId, runId: owner.runId },
      ...(scope === "global"
        ? [
            {
              kind: "user_message" as const,
              sessionId: owner.sessionId,
              userMessageId: owner.userMessageId,
            },
          ]
        : []),
    ],
  });

  it("stores canonical untrusted external references and keeps external-only proposals under review", () => {
    const input = {
      ...proposal("External claim needs local confirmation"),
      evidence: [
        {
          kind: "external_reference",
          externalReference: {
            url: "HTTPS://Example.com/path?q=ok#fragment",
            title: "Source title",
            sourceLabel: "spoofed",
            retrievedAt: "2000-01-01T00:00:00.000Z",
            origin: "mcp_attested",
          },
        },
      ],
    } as Parameters<typeof service.proposeProjectMemory>[0];
    const record = service.proposeProjectMemory(input, context);
    expect(record.status).toBe("needs_review");
    expect(record.evidence[0]).toMatchObject({
      kind: "external_reference",
      externalReference: {
        url: "https://example.com/path?q=ok",
        title: "Source title",
        sourceLabel: "Agent-supplied",
        origin: "agent_supplied_unverified",
      },
    });
    const externalReference = record.evidence[0]?.externalReference;
    expect(Date.parse(externalReference?.retrievedAt ?? "")).toBeGreaterThan(0);
    expect(
      service.retrieveProjectMemory({
        workspaceId: context.workspaceId,
        inbox: false,
        query: "",
        contextPaths: [],
        contextSymbols: [],
        git: { changedPaths: [] },
      }).memoryIds,
    ).not.toContain(record.id);
    expect(() => service.proposeProjectMemory({ ...input, scope: "global" }, context)).toThrow();
  });

  it("rejects unsafe external URLs and dedupes references without promoting external-only claims", () => {
    const make = (url: string) =>
      ({
        ...proposal("External URL validation claim"),
        evidence: [{ kind: "external_reference", externalReference: { url } }],
      }) as Parameters<typeof service.proposeProjectMemory>[0];
    for (const url of [
      "javascript:alert(1)",
      "https://user:password@example.com/",
      "https://example.com/?api_key=secret",
      `https://example.com/${"a".repeat(1100)}`,
    ]) {
      expect(() => service.proposeProjectMemory(make(url), context)).toThrow();
    }
    const first = service.proposeProjectMemory(make("https://example.com/a#one"), context);
    const deduped = service.proposeProjectMemory(make("https://example.com/a#two"), context);
    expect(deduped.id).toBe(first.id);
    expect(deduped.status).toBe("needs_review");
    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "completed",
    });
    expect(
      service
        .getProjectMemorySnapshot(context.workspaceId)
        .memories.find((item) => item.id === first.id)?.status,
    ).toBe("needs_review");
    service.verifyProjectMemory(first.id);
    expect(
      service.retrieveProjectMemory({
        workspaceId: context.workspaceId,
        inbox: false,
        query: "",
        contextPaths: [],
        contextSymbols: [],
        git: { changedPaths: [] },
      }).memoryIds,
    ).toContain(first.id);
  });

  it.each([
    "sessionId",
    "SESSION_ID",
    "session_id",
    "refreshToken",
    "REFRESH_TOKEN",
    "refresh_token",
  ])("rejects credential-like query key %s on new and deduped direct proposals", (queryKey) => {
    const claim = `Reject sensitive URL query key ${queryKey}`;
    const make = (url: string) =>
      ({
        ...proposal(claim),
        evidence: [{ kind: "external_reference", externalReference: { url } }],
      }) as Parameters<typeof service.proposeProjectMemory>[0];
    expect(() =>
      service.proposeProjectMemory(make(`https://example.com/new?${queryKey}=secret`), context),
    ).toThrow(/URL/i);

    const first = service.proposeProjectMemory(make("https://example.com/safe?lang=en"), context);
    expect(() =>
      service.proposeProjectMemory(make(`https://example.com/safe?${queryKey}=secret`), context),
    ).toThrow(/URL/i);
    expect(
      service
        .getProjectMemorySnapshot(context.workspaceId)
        .memories.find((item) => item.id === first.id)?.evidence,
    ).toHaveLength(1);
  });

  it("accepts only an exact registry-issued citation at proposal time", () => {
    const [citation] = registerMcpCitations(
      context.sessionId,
      context.runId,
      "Trusted MCP",
      "search",
      {
        content: [
          {
            type: "resource_link",
            uri: "https://example.com/attested#section",
            name: "Attested result",
          },
        ],
      } as never,
    );
    if (!citation) throw new Error("Expected registered citation");
    const proposalInput = {
      ...proposal("MCP cited claim"),
      evidence: [{ kind: "external_reference", citationId: citation.id }],
    } as unknown as Parameters<typeof service.proposeProjectMemory>[0];
    const record = service.proposeProjectMemory(proposalInput, context);
    expect(record.evidence[0]).toMatchObject({
      externalReference: {
        url: "https://example.com/attested",
        title: "Attested result",
        sourceLabel: "Trusted MCP",
        retrievedAt: citation.retrievedAt,
        origin: "mcp_attested",
      },
    });
    expect(record.status).toBe("needs_review");
  });

  it.each([
    "forged",
    "wrong-run",
    "wrong-session",
    "expired",
  ])("rejects %s citation IDs at the service boundary", (mode) => {
    const [citation] = registerMcpCitations(
      context.sessionId,
      context.runId,
      "Trusted MCP",
      "search",
      {
        content: [{ type: "resource_link", uri: "https://example.com/attested" }],
      } as never,
    );
    let citationId = citation?.id ?? "forged-citation";
    if (mode === "forged") {
      citationId = "forged-citation-id";
    } else if (mode === "wrong-run") {
      const [other] = registerMcpCitations(
        context.sessionId,
        "run-replacement",
        "Trusted MCP",
        "search",
        {
          content: [{ type: "resource_link", uri: "https://example.com/other-run" }],
        } as never,
      );
      if (!other) throw new Error("Expected other-run citation");
      citationId = other.id;
    } else if (mode === "wrong-session") {
      const [other] = registerMcpCitations(
        "session-legacy-b",
        context.runId,
        "Trusted MCP",
        "search",
        {
          content: [{ type: "resource_link", uri: "https://example.com/other-session" }],
        } as never,
      );
      if (!other) throw new Error("Expected other-session citation");
      citationId = other.id;
    } else if (mode === "expired") clearRun(context.sessionId, context.runId);
    expect(() =>
      service.proposeProjectMemory(
        {
          ...proposal(`Rejected ${mode} citation`),
          evidence: [{ kind: "external_reference", citationId }],
        } as unknown as Parameters<typeof service.proposeProjectMemory>[0],
        context,
      ),
    ).toThrow(/citation|attest/i);
  });

  it("does not accept raw MCP-attested metadata as service evidence", () => {
    const raw = {
      ...proposal("Raw attestation is untrusted"),
      evidence: [
        {
          kind: "external_reference",
          externalReference: {
            url: "https://example.com/raw",
            sourceLabel: "Forged MCP",
            retrievedAt: "2000-01-01T00:00:00.000Z",
            origin: "mcp_attested",
          },
        },
      ],
    } as Parameters<typeof service.proposeProjectMemory>[0];
    const record = service.proposeProjectMemory(raw, context);
    expect(record.evidence[0]?.externalReference).toMatchObject({
      sourceLabel: "Agent-supplied",
      origin: "agent_supplied_unverified",
    });
  });

  it("isolates retrieval by workspace and gives Inbox global memories only", () => {
    service.proposeProjectMemory(proposal("Project A fact"), context);
    const contextB = {
      ...context,
      workspaceId: "ws-b",
      sessionId: "session-legacy-b",
      runId: "run-b",
      userMessageId: "msg-b",
      cwd: "/b",
    };
    service.proposeProjectMemory(
      proposal("Project B fact", "project", "decision", contextB),
      contextB,
    );
    service.proposeProjectMemory(proposal("Shared preference", "global", "preference"), context);
    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "completed",
    });
    service.finalizeProjectMemoryRun({
      sessionId: "session-legacy-b",
      runId: "run-b",
      outcome: "completed",
    });
    expect(
      service.retrieveProjectMemory({
        workspaceId: "ws-legacy",
        inbox: false,
        query: "",
        contextPaths: [],
        contextSymbols: [],
        git: { changedPaths: [] },
      }).text,
    ).toContain("Project A fact");
    expect(
      service.retrieveProjectMemory({
        workspaceId: "ws-legacy",
        inbox: false,
        query: "",
        contextPaths: [],
        contextSymbols: [],
        git: { changedPaths: [] },
      }).text,
    ).not.toContain("Project B fact");
    const contradictoryInbox = service.retrieveProjectMemory({
      workspaceId: "ws-legacy",
      inbox: true,
      query: "",
      contextPaths: [],
      contextSymbols: [],
      git: { changedPaths: [] },
    });
    expect(contradictoryInbox.text).toContain("Shared preference");
    expect(contradictoryInbox.text).not.toContain("Project A fact");
    const inbox = service.retrieveProjectMemory({
      inbox: true,
      query: "",
      contextPaths: [],
      contextSymbols: [],
      git: { changedPaths: [] },
    });
    expect(inbox.text).toContain("Shared preference");
    expect(inbox.text).not.toContain("Project A fact");
    const inboxIdentity = service.retrieveProjectMemory({
      workspaceId: CHATS_WORKSPACE_ID,
      inbox: false,
      query: "",
      contextPaths: [],
      contextSymbols: [],
      git: { changedPaths: [] },
    });
    expect(inboxIdentity.text).toContain("Shared preference");
    expect(inboxIdentity.text).not.toContain("Project A fact");
  });

  it("defaults settings on and persists a disabled scope", () => {
    expect(service.getProjectMemorySnapshot("ws-legacy").projectEnabled).toBe(true);
    expect(
      service.setProjectMemoryEnabled({
        scope: { kind: "project", workspaceId: "ws-legacy" },
        enabled: false,
      }).projectEnabled,
    ).toBe(false);
    expect(service.getProjectMemorySnapshot("ws-legacy").projectEnabled).toBe(false);
    expect(
      service.setProjectMemoryEnabled({ scope: { kind: "global" }, enabled: false }).globalEnabled,
    ).toBe(false);
    expect(
      service.setProjectMemoryEnabled({ scope: { kind: "global" }, enabled: true }).globalEnabled,
    ).toBe(true);
    service.setProjectMemoryEnabled({
      scope: { kind: "project", workspaceId: "ws-legacy" },
      enabled: true,
    });
  });

  it("deduplicates equivalent proposals idempotently", () => {
    const input = proposal("Use stable identifiers", "project", "convention");
    expect(service.proposeProjectMemory(input, context).id).toBe(
      service.proposeProjectMemory(input, context).id,
    );
  });

  it("rejects forged ownership and binds every evidence reference to the persisted owning run", () => {
    expect(() =>
      service.proposeProjectMemory(proposal("Spoofed session"), {
        ...context,
        sessionId: "session-legacy-b",
      }),
    ).toThrow(/context|session|run/i);
    expect(() =>
      service.proposeProjectMemory(proposal("Spoofed run"), { ...context, runId: "run-b" }),
    ).toThrow(/context|session|run/i);
    expect(() =>
      service.proposeProjectMemory(
        {
          ...proposal("Spoofed message", "global", "preference"),
          evidence: [{ kind: "user_message", userMessageId: "msg-b" }],
        },
        context,
      ),
    ).toThrow(/user-origin/i);
    expect(() =>
      service.proposeProjectMemory(
        {
          ...proposal("Forged message field"),
          evidence: [{ kind: "run", userMessageId: "msg-b" }],
        },
        context,
      ),
    ).toThrow(/user message|provenance/i);
    const record = service.proposeProjectMemory(
      {
        ...proposal("Bound evidence"),
        evidence: [{ kind: "run", sessionId: "session-legacy", runId: "run-1" }],
      },
      context,
    );
    expect(record.evidence).toEqual([{ kind: "run", sessionId: "session-legacy", runId: "run-1" }]);
  });

  it("rejects proposals when their global or project memory scope is disabled", () => {
    service.setProjectMemoryEnabled({
      scope: { kind: "project", workspaceId: "ws-legacy" },
      enabled: false,
    });
    expect(() => service.proposeProjectMemory(proposal("Disabled project write"), context)).toThrow(
      /disabled/i,
    );
    service.setProjectMemoryEnabled({ scope: { kind: "global" }, enabled: false });
    expect(() =>
      service.proposeProjectMemory(
        proposal("Disabled global write", "global", "preference"),
        context,
      ),
    ).toThrow(/disabled/i);
    service.setProjectMemoryEnabled({
      scope: { kind: "project", workspaceId: "ws-legacy" },
      enabled: true,
    });
    service.setProjectMemoryEnabled({ scope: { kind: "global" }, enabled: true });
  });

  it("rejects project-scoped proposals for persisted Inbox sessions", () => {
    const inboxContext = {
      ...context,
      workspaceId: CHATS_WORKSPACE_ID,
      sessionId: "session-inbox",
      runId: "run-inbox",
      userMessageId: "msg-inbox",
      cwd: "/inbox",
    };
    expect(() =>
      service.proposeProjectMemory(
        proposal("Inbox project-only fact", "project", "decision", inboxContext),
        inboxContext,
      ),
    ).toThrow(/inbox|global/i);
  });

  it("rejects global provenance from every persisted child session, including shared-checkout children", () => {
    const childContext = {
      ...context,
      sessionId: "session-shared-child",
      runId: "run-shared-child",
      userMessageId: "subagent-user:synthetic-message",
    };
    const counts = () => ({
      records: (
        db.prepare("select count(*) as count from project_memory_records").get() as {
          count: number;
        }
      ).count,
      evidence: (
        db.prepare("select count(*) as count from project_memory_evidence").get() as {
          count: number;
        }
      ).count,
      events: (
        db.prepare("select count(*) as count from project_memory_events").get() as { count: number }
      ).count,
    });
    const before = counts();
    expect(() =>
      service.proposeProjectMemory(
        {
          ...proposal("Child global preference", "global", "preference", childContext),
          evidence: [{ kind: "user_message", userMessageId: childContext.userMessageId }],
        },
        childContext,
      ),
    ).toThrow(/child|parent|global/i);
    expect(counts()).toEqual(before);
  });

  it("derives provisional status from persisted worktree ownership, not a context flag", () => {
    const ordinary = service.proposeProjectMemory(
      proposal("Ordinary session ignores worktree flag"),
      { ...context, subagentWorktree: true },
    );
    expect(ordinary.status).toBe("candidate");
    const worktreeContext = {
      ...context,
      sessionId: "session-worktree",
      runId: "run-worktree",
      userMessageId: "msg-worktree",
      cwd: "/legacy/.worktrees/child",
      subagentWorktree: false,
    };
    const worktree = service.proposeProjectMemory(
      proposal("Persisted worktree stays provisional", "project", "decision", worktreeContext),
      worktreeContext,
    );
    expect(worktree.status).toBe("provisional");
  });

  it("keeps an active memory unchanged if the obsolete event insert fails", () => {
    const memory = service.proposeProjectMemory(proposal("Atomic obsolete transition"), context);
    service.verifyProjectMemory(memory.id);
    db.exec(`create trigger fail_obsolete_event before insert on project_memory_events
      when new.memory_id = '${memory.id}' and new.to_status = 'obsolete'
      begin select raise(abort, 'injected obsolete event failure'); end`);
    expect(() => service.markProjectMemoryObsolete(memory.id)).toThrow(
      /injected obsolete event failure/,
    );
    db.exec("drop trigger fail_obsolete_event");
    expect(
      db.prepare("select status from project_memory_records where id = ?").get(memory.id),
    ).toEqual({ status: "active" });
  });

  it("supports rollback invalidation inside a caller-owned SQLite transaction", () => {
    const record = service.proposeProjectMemory(proposal("Composable rollback claim"), context);
    db.exec("begin");
    try {
      expect(() =>
        service.invalidateProjectMemoriesForRuns(context.sessionId, [context.runId]),
      ).not.toThrow();
      db.exec("rollback");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    expect(
      (
        db.prepare("select status from project_memory_records where id = ?").get(record.id) as {
          status: string;
        }
      ).status,
    ).toBe("candidate");
  });

  it("finalizes multiple candidates atomically and idempotently per memory/run", () => {
    const first = service.proposeProjectMemory(proposal("First atomic candidate"), context);
    const second = service.proposeProjectMemory(proposal("Second atomic candidate"), context);
    db.exec(`create trigger fail_second_memory_event before insert on project_memory_events
      when new.memory_id = '${second.id}' and new.to_status = 'active'
      begin select raise(abort, 'injected event failure'); end`);
    expect(() =>
      service.finalizeProjectMemoryRun({
        sessionId: context.sessionId,
        runId: context.runId,
        outcome: "completed",
      }),
    ).toThrow(/injected event failure/);
    db.exec("drop trigger fail_second_memory_event");
    expect(
      db.prepare("select status from project_memory_records where id = ?").get(first.id),
    ).toEqual({ status: "candidate" });
    expect(
      db.prepare("select status from project_memory_records where id = ?").get(second.id),
    ).toEqual({ status: "candidate" });

    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "completed",
    });
    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "completed",
    });
    for (const memoryId of [first.id, second.id]) {
      expect(
        db.prepare("select status from project_memory_records where id = ?").get(memoryId),
      ).toEqual({ status: "active" });
      expect(
        db
          .prepare(
            "select count(*) as count from project_memory_events where memory_id = ? and to_status = 'active'",
          )
          .get(memoryId),
      ).toEqual({ count: 1 });
    }
    const keys = db
      .prepare(
        "select idempotency_key from project_memory_events where memory_id in (?, ?) and to_status = 'active'",
      )
      .all(first.id, second.id) as Array<{ idempotency_key: string }>;
    expect(new Set(keys.map((row) => row.idempotency_key)).size).toBe(2);
  });

  it("records one successful compaction event per linked record across retries and later proposals", () => {
    const first = service.proposeProjectMemory(
      proposal("First compaction bookkeeping candidate"),
      context,
    );
    const second = service.proposeProjectMemory(
      proposal("Second compaction bookkeeping candidate"),
      context,
    );
    const stateBefore = [first.id, second.id].map((id) =>
      db
        .prepare(
          `select status, verification, last_verified_at from project_memory_records where id = ?`,
        )
        .get(id),
    );
    const compact = () =>
      service.recordProjectMemoryCompaction({
        sessionId: context.sessionId,
        runId: context.runId,
        aborted: false,
        willRetry: false,
      });

    compact();
    compact();
    const later = service.proposeProjectMemory(
      proposal("Later compaction bookkeeping candidate"),
      context,
    );
    compact();

    for (const memory of [first, second, later]) {
      const events = db
        .prepare(`select from_status, to_status, actor, reason, idempotency_key
        from project_memory_events where memory_id = ? and idempotency_key = ?`)
        .all(memory.id, `compaction:${context.sessionId}:${context.runId}`);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        from_status: "candidate",
        to_status: "candidate",
        actor: "main",
        reason: expect.stringMatching(/successful compaction/i),
        idempotency_key: `compaction:${context.sessionId}:${context.runId}`,
      });
      expect(JSON.stringify(events[0])).not.toContain(memory.claim);
    }
    expect(
      [first.id, second.id].map((id) =>
        db
          .prepare(
            `select status, verification, last_verified_at from project_memory_records where id = ?`,
          )
          .get(id),
      ),
    ).toEqual(stateBefore);
  });

  it("does not write compaction events for empty, invalid, aborted, or retrying compactions", () => {
    const owner = {
      ...context,
      sessionId: "session-prior",
      runId: "run-prior",
      userMessageId: "msg-prior",
    };
    const key = `compaction:${owner.sessionId}:${owner.runId}`;
    const record = service.proposeProjectMemory(
      proposal("Candidate unaffected by interrupted compaction", "project", "decision", owner),
      owner,
    );
    const compact = (
      overrides: Partial<Parameters<typeof service.recordProjectMemoryCompaction>[0]> = {},
    ) =>
      service.recordProjectMemoryCompaction({
        sessionId: owner.sessionId,
        runId: owner.runId,
        aborted: false,
        willRetry: false,
        ...overrides,
      });

    compact({ sessionId: "missing-session" });
    compact({ runId: "missing-run" });
    compact({ aborted: true });
    compact({ willRetry: true });
    service.recordProjectMemoryCompaction({
      sessionId: "session-legacy-b",
      runId: owner.runId,
      aborted: false,
      willRetry: false,
    });

    expect(
      db
        .prepare(
          "select count(*) as count from project_memory_events where memory_id = ? and idempotency_key like 'compaction:%'",
        )
        .get(record.id),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("select count(*) as count from project_memory_events where idempotency_key = ?")
        .get(key),
    ).toEqual({ count: 0 });

    const emptyRun = "run-inbox";
    service.recordProjectMemoryCompaction({
      sessionId: "session-inbox",
      runId: emptyRun,
      aborted: false,
      willRetry: false,
    });
    expect(
      db
        .prepare("select count(*) as count from project_memory_events where idempotency_key = ?")
        .get(`compaction:session-inbox:${emptyRun}`),
    ).toEqual({ count: 0 });
  });

  it("rolls back all compaction bookkeeping events if one record event insert fails", () => {
    const first = service.proposeProjectMemory(proposal("Atomic compaction event first"), context);
    const second = service.proposeProjectMemory(
      proposal("Atomic compaction event second"),
      context,
    );
    db.exec(`create trigger fail_second_compaction_event before insert on project_memory_events
      when new.memory_id = '${second.id}' and new.idempotency_key like 'compaction:%'
      begin select raise(abort, 'injected compaction event failure'); end`);
    expect(() =>
      service.recordProjectMemoryCompaction({
        sessionId: context.sessionId,
        runId: context.runId,
        aborted: false,
        willRetry: false,
      }),
    ).toThrow(/injected compaction event failure/);
    db.exec("drop trigger fail_second_compaction_event");
    expect(
      db
        .prepare(
          "select count(*) as count from project_memory_events where memory_id in (?, ?) and idempotency_key like 'compaction:%'",
        )
        .get(first.id, second.id),
    ).toEqual({ count: 0 });
  });

  it("retains predecessors until replacement candidates become eligible", () => {
    const predecessor = service.proposeProjectMemory(
      proposal("Established predecessor fact"),
      context,
    );
    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "completed",
    });
    const failedReplacement = service.proposeProjectMemory(
      { ...proposal("Failed replacement fact"), supersedesId: predecessor.id },
      context,
    );
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === predecessor.id)?.status,
    ).toBe("active");
    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "failed",
    });
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === predecessor.id)?.status,
    ).toBe("active");
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === failedReplacement.id)?.status,
    ).toBe("candidate");
    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "completed",
    });
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === predecessor.id)?.status,
    ).toBe("superseded");
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === failedReplacement.id)?.status,
    ).toBe("active");

    const provisionalPredecessor = service.proposeProjectMemory(
      proposal("Worktree predecessor fact"),
      context,
    );
    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "completed",
    });
    const worktreeContext = {
      ...context,
      sessionId: "session-worktree",
      runId: "run-worktree",
      userMessageId: "msg-worktree",
      cwd: "/legacy/.worktrees/child",
      subagentWorktree: false,
    };
    const provisional = service.proposeProjectMemory(
      {
        ...proposal("Provisional replacement fact", "project", "decision", worktreeContext),
        supersedesId: provisionalPredecessor.id,
      },
      worktreeContext,
    );
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === provisionalPredecessor.id)?.status,
    ).toBe("active");
    service.finalizeProjectMemoryRun({
      sessionId: worktreeContext.sessionId,
      runId: worktreeContext.runId,
      outcome: "completed",
    });
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === provisionalPredecessor.id)?.status,
    ).toBe("active");
    service.verifyProjectMemory(provisional.id);
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === provisionalPredecessor.id)?.status,
    ).toBe("superseded");
  });

  it("restores a superseded predecessor when its only promoted replacement is rolled back", () => {
    const predecessor = service.proposeProjectMemory(
      proposal("Prior verified implementation"),
      context,
    );
    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "completed",
    });
    const replacementContext = {
      ...context,
      runId: "run-replacement",
      userMessageId: "msg-replacement",
    };
    const replacement = service.proposeProjectMemory(
      {
        ...proposal("Replacement implementation", "project", "decision", replacementContext),
        supersedesId: predecessor.id,
      },
      replacementContext,
    );
    service.finalizeProjectMemoryRun({
      sessionId: replacementContext.sessionId,
      runId: replacementContext.runId,
      outcome: "completed",
    });
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === predecessor.id)?.status,
    ).toBe("superseded");
    service.invalidateProjectMemoriesForRuns(replacementContext.sessionId, [
      replacementContext.runId,
    ]);
    const memories = service.getProjectMemorySnapshot("ws-legacy").memories;
    expect(memories.find((memory) => memory.id === replacement.id)?.status).toBe("needs_review");
    expect(memories.find((memory) => memory.id === predecessor.id)?.status).toBe("active");
  });

  it("does not restore a predecessor when the same rollback invalidates both chain sources", () => {
    const sourceContext = {
      ...context,
      sessionId: "session-dedupe",
      runId: "run-dedupe-a",
      userMessageId: "msg-dedupe-a",
    };
    const replacementContext = {
      ...sourceContext,
      runId: "run-dedupe-b",
      userMessageId: "msg-dedupe-b",
    };
    const predecessor = service.proposeProjectMemory(
      proposal("Both-source predecessor claim", "project", "decision", sourceContext),
      sourceContext,
    );
    service.finalizeProjectMemoryRun({
      sessionId: sourceContext.sessionId,
      runId: sourceContext.runId,
      outcome: "completed",
    });
    const replacement = service.proposeProjectMemory(
      {
        ...proposal("Both-source replacement claim", "project", "decision", replacementContext),
        supersedesId: predecessor.id,
      },
      replacementContext,
    );
    service.finalizeProjectMemoryRun({
      sessionId: replacementContext.sessionId,
      runId: replacementContext.runId,
      outcome: "completed",
    });

    service.invalidateProjectMemoriesForRuns(sourceContext.sessionId, [
      sourceContext.runId,
      replacementContext.runId,
    ]);
    const memories = service.getProjectMemorySnapshot("ws-legacy").memories;
    expect(memories.find((memory) => memory.id === replacement.id)?.status).toBe("needs_review");
    expect(memories.find((memory) => memory.id === predecessor.id)?.status).toBe("needs_review");
    expect(memories.find((memory) => memory.id === predecessor.id)?.status).not.toBe("active");
  });

  it("restores a superseded predecessor to its prior candidate state after replacement rollback", () => {
    const predecessorContext = {
      ...context,
      sessionId: "session-prior",
      runId: "run-prior",
      userMessageId: "msg-prior",
    };
    const replacementContext = {
      ...predecessorContext,
      runId: "run-prior-replacement",
      userMessageId: "msg-prior-replacement",
    };
    const predecessor = service.proposeProjectMemory(
      proposal("Unfinalized predecessor candidate", "project", "decision", predecessorContext),
      predecessorContext,
    );
    expect(predecessor.status).toBe("candidate");
    const replacement = service.proposeProjectMemory(
      {
        ...proposal("Promoted replacement candidate", "project", "decision", replacementContext),
        supersedesId: predecessor.id,
      },
      replacementContext,
    );
    service.finalizeProjectMemoryRun({
      sessionId: replacementContext.sessionId,
      runId: replacementContext.runId,
      outcome: "completed",
    });
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === replacement.id)?.status,
    ).toBe("active");
    service.invalidateProjectMemoriesForRuns(replacementContext.sessionId, [
      replacementContext.runId,
    ]);
    const memories = service.getProjectMemorySnapshot("ws-legacy").memories;
    expect(memories.find((memory) => memory.id === replacement.id)?.status).toBe("needs_review");
    expect(memories.find((memory) => memory.id === predecessor.id)?.status).toBe("candidate");
    const rollbackEvents = db
      .prepare(`select memory_id, from_status, to_status from project_memory_events
      where memory_id in (?, ?) order by rowid desc limit 2`)
      .all(predecessor.id, replacement.id) as Array<{
      memory_id: string;
      from_status: string;
      to_status: string;
    }>;
    expect(rollbackEvents.reverse()).toEqual([
      { memory_id: replacement.id, from_status: "active", to_status: "needs_review" },
      { memory_id: predecessor.id, from_status: "superseded", to_status: "candidate" },
    ]);
  });

  it("restores an active predecessor after its chat evidence was detached", () => {
    const predecessorContext = {
      ...context,
      sessionId: "session-detached-prior",
      runId: "run-detached-prior",
      userMessageId: "msg-detached-prior",
    };
    const predecessor = service.proposeProjectMemory(
      proposal(
        "Active predecessor with detached source",
        "project",
        "decision",
        predecessorContext,
      ),
      predecessorContext,
    );
    service.finalizeProjectMemoryRun({
      sessionId: predecessorContext.sessionId,
      runId: predecessorContext.runId,
      outcome: "completed",
    });
    db.prepare("delete from agent_sessions where id = ?").run(predecessorContext.sessionId);
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === predecessor.id)?.evidence[0]?.detached,
    ).toBe(true);

    const replacement = service.proposeProjectMemory(
      {
        ...proposal("Replacement of detached source", "project", "decision"),
        supersedesId: predecessor.id,
      },
      context,
    );
    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "completed",
    });
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === predecessor.id)?.status,
    ).toBe("superseded");
    service.invalidateProjectMemoriesForRuns(context.sessionId, [context.runId]);
    const memories = service.getProjectMemorySnapshot("ws-legacy").memories;
    expect(memories.find((memory) => memory.id === replacement.id)?.status).toBe("needs_review");
    expect(memories.find((memory) => memory.id === predecessor.id)?.status).toBe("active");
    const rollbackEvents = db
      .prepare(`select memory_id, from_status, to_status from project_memory_events
      where memory_id in (?, ?) order by rowid desc limit 2`)
      .all(predecessor.id, replacement.id) as Array<{
      memory_id: string;
      from_status: string;
      to_status: string;
    }>;
    expect(rollbackEvents.reverse()).toEqual([
      { memory_id: replacement.id, from_status: "active", to_status: "needs_review" },
      { memory_id: predecessor.id, from_status: "superseded", to_status: "active" },
    ]);
  });

  it("attaches validated evidence on a dedupe hit so later completion can recover needs-review memory", () => {
    const dedupeContext = {
      ...context,
      sessionId: "session-dedupe",
      runId: "run-dedupe-a",
      userMessageId: "msg-dedupe-a",
    };
    const initial = service.proposeProjectMemory(
      proposal("Reusable claim with multiple sources", "project", "decision", dedupeContext),
      dedupeContext,
    );
    service.finalizeProjectMemoryRun({
      sessionId: dedupeContext.sessionId,
      runId: dedupeContext.runId,
      outcome: "completed",
    });
    service.invalidateProjectMemoriesForRuns(dedupeContext.sessionId, [dedupeContext.runId]);
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === initial.id)?.status,
    ).toBe("needs_review");

    const secondContext = {
      ...dedupeContext,
      runId: "run-dedupe-b",
      userMessageId: "msg-dedupe-b",
    };
    const deduped = service.proposeProjectMemory(
      proposal("Reusable claim with multiple sources", "project", "decision", secondContext),
      secondContext,
    );
    expect(deduped.id).toBe(initial.id);
    expect(deduped.evidence.map((item) => item.runId)).toEqual(
      expect.arrayContaining([dedupeContext.runId, secondContext.runId]),
    );
    service.finalizeProjectMemoryRun({
      sessionId: secondContext.sessionId,
      runId: secondContext.runId,
      outcome: "completed",
    });
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === initial.id)?.status,
    ).toBe("active");

    const evidence = db
      .prepare(
        "select session_id, run_id, user_message_id from project_memory_evidence where memory_id = ?",
      )
      .all(initial.id);
    expect(evidence).toHaveLength(2);
    db.prepare("delete from agent_sessions where id = ?").run(dedupeContext.sessionId);
    const detached = db
      .prepare(
        "select session_id, run_id, user_message_id, detached from project_memory_evidence where memory_id = ?",
      )
      .all(initial.id);
    expect(detached).toHaveLength(2);
    expect(
      detached.every(
        (item) =>
          item.session_id === null &&
          item.run_id === null &&
          item.user_message_id === null &&
          item.detached === 1,
      ),
    ).toBe(true);
  });

  it("does not reactivate a needs-review dedupe hit using only worktree evidence", () => {
    const claim = "Worktree evidence alone cannot verify this claim";
    const original = service.proposeProjectMemory(proposal(claim), context);
    service.finalizeProjectMemoryRun({
      sessionId: context.sessionId,
      runId: context.runId,
      outcome: "completed",
    });
    service.invalidateProjectMemoriesForRuns(context.sessionId, [context.runId]);
    const worktreeContext = {
      ...context,
      sessionId: "session-worktree",
      runId: "run-worktree",
      userMessageId: "msg-worktree",
      cwd: "/legacy/.worktrees/child",
      subagentWorktree: false,
    };
    const deduped = service.proposeProjectMemory(
      proposal(claim, "project", "decision", worktreeContext),
      worktreeContext,
    );
    expect(deduped.id).toBe(original.id);
    service.finalizeProjectMemoryRun({
      sessionId: worktreeContext.sessionId,
      runId: worktreeContext.runId,
      outcome: "completed",
    });
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === original.id)?.status,
    ).toBe("needs_review");
  });

  it("records allowed lifecycle transitions, explicit supersession, and rejects illegal transitions", () => {
    const first = service.proposeProjectMemory(proposal("Old decision"), context);
    expect(
      service.finalizeProjectMemoryRun({
        sessionId: context.sessionId,
        runId: context.runId,
        outcome: "completed",
      }),
    ).toBeUndefined();
    const replacement = service.proposeProjectMemory(
      { ...proposal("New decision"), supersedesId: first.id },
      context,
    );
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === first.id)?.status,
    ).toBe("active");
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === replacement.id)?.status,
    ).toBe("candidate");
    expect(() => service.markProjectMemoryObsolete("missing-id")).not.toThrow();
    service.verifyProjectMemory(replacement.id);
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === replacement.id)?.status,
    ).toBe("active");
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === first.id)?.status,
    ).toBe("superseded");
    service.markProjectMemoryObsolete(replacement.id);
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === replacement.id)?.status,
    ).toBe("obsolete");
    expect(() => service.verifyProjectMemory(replacement.id)).toThrow(
      /Illegal project memory transition/,
    );
  });

  it("detaches chat evidence, invalidates rolled-back run memories, and never persists transcripts", () => {
    const record = service.proposeProjectMemory(proposal("Concise durable claim"), context);
    service.invalidateProjectMemoriesForRuns(context.sessionId, [context.runId]);
    service.detachProjectMemoryEvidenceForSession(context.sessionId);
    const stored = db
      .prepare("select claim, status from project_memory_records where id = ?")
      .get(record.id) as { claim: string; status: string };
    expect(stored).toEqual({ claim: "Concise durable claim", status: "needs_review" });
    const evidence = db
      .prepare(
        "select session_id, run_id, detached from project_memory_evidence where memory_id = ?",
      )
      .all(record.id) as Array<{
      session_id: string | null;
      run_id: string | null;
      detached: number;
    }>;
    expect(
      evidence.every(
        (item) => item.session_id === null && item.run_id === null && item.detached === 1,
      ),
    ).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("transcript");
  });

  it("validates evidence paths and requires user-origin evidence for global proposals", () => {
    expect(() =>
      service.proposeProjectMemory(
        { ...proposal("Global preference", "global", "preference"), evidence: [] },
        context,
      ),
    ).toThrow();
    expect(() =>
      service.proposeProjectMemory(
        {
          ...proposal("Global preference", "global", "preference"),
          evidence: [{ kind: "user_message" }],
        },
        context,
      ),
    ).toThrow();
    expect(() =>
      service.proposeProjectMemory(
        {
          ...proposal("Project path", "project"),
          evidence: [{ kind: "file", path: "../outside.ts" }],
        },
        context,
      ),
    ).toThrow();
    for (const path of ["C:\\legacy\\inside.ts", "\\legacy\\inside.ts", "C:inside.ts"]) {
      expect(() =>
        service.proposeProjectMemory(
          { ...proposal(`Absolute path ${path}`), evidence: [{ kind: "file", path }] },
          context,
        ),
      ).toThrow(/relative|absolute/i);
    }
    expect(() => service.proposeProjectMemory(proposal("A".repeat(5000)), context)).toThrow();
  });

  it("rejects credential material in claims, titles, and free-text evidence while allowing discussion", () => {
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(48)}\n-----END PRIVATE KEY-----`;
    const encryptedPrivateKey = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${"B".repeat(48)}\n-----END ENCRYPTED PRIVATE KEY-----`;
    const providerToken = `sk-proj-${"a".repeat(40)}`;
    const githubToken = `ghp_${"G".repeat(32)}`;
    const bearer = `Bearer eyJ${"a".repeat(32)}.${"b".repeat(32)}.${"c".repeat(32)}`;
    const assignment = `client_secret=${"xYz".repeat(12)}`;
    const counts = () => ({
      records: (
        db.prepare("select count(*) as count from project_memory_records").get() as {
          count: number;
        }
      ).count,
      evidence: (
        db.prepare("select count(*) as count from project_memory_evidence").get() as {
          count: number;
        }
      ).count,
      events: (
        db.prepare("select count(*) as count from project_memory_events").get() as { count: number }
      ).count,
    });
    const rejectWithoutWrites = (
      proposalInput: Parameters<typeof service.proposeProjectMemory>[0],
    ) => {
      const before = counts();
      expect(() => service.proposeProjectMemory(proposalInput, context)).toThrow(/secret/i);
      expect(counts()).toEqual(before);
    };
    rejectWithoutWrites({ ...proposal("Private key claim check"), claim: privateKey });
    rejectWithoutWrites({ ...proposal("Encrypted private key check"), claim: encryptedPrivateKey });
    rejectWithoutWrites({ ...proposal("Known token title"), title: `Provider ${providerToken}` });
    rejectWithoutWrites({ ...proposal("GitHub token title"), title: githubToken });
    rejectWithoutWrites({
      ...proposal("Bearer metadata check"),
      evidence: [{ kind: "task", taskRef: bearer }],
    });
    rejectWithoutWrites({
      ...proposal("Assignment metadata check"),
      evidence: [{ kind: "task", taskRef: assignment }],
    });
    rejectWithoutWrites({
      ...proposal("Generic token assignment"),
      evidence: [{ kind: "task", taskRef: `token=${"t".repeat(32)}` }],
    });
    expect(() =>
      service.proposeProjectMemory(
        {
          ...proposal("Discuss safe handling of secrets"),
          claim:
            "Discuss secret rotation, API keys, bearer authentication, and private-key storage; never paste credentials into source control.",
          evidence: [{ kind: "task", taskRef: "Document credential rotation policy" }],
        },
        context,
      ),
    ).not.toThrow();
  });

  it("bounds every evidence string field and the evidence array size", () => {
    expect(service.PROJECT_MEMORY_LIMITS).toEqual({
      titleChars: MAX_TITLE_LENGTH,
      claimChars: MAX_CLAIM_LENGTH,
      evidenceItems: MAX_EVIDENCE_COUNT,
      evidenceStringChars: MAX_EVIDENCE_STRING_LENGTH,
    });
    const fields = [
      "sessionId",
      "runId",
      "userMessageId",
      "taskRef",
      "commitSha",
      "branch",
      "path",
      "symbol",
    ] as const;
    for (const field of fields) {
      const evidence = {
        kind: "run" as const,
        sessionId: context.sessionId,
        runId: context.runId,
        [field]: "x".repeat(MAX_EVIDENCE_STRING_LENGTH + 1),
      } as Parameters<typeof service.proposeProjectMemory>[0]["evidence"][number];
      expect(() =>
        service.proposeProjectMemory(
          { ...proposal(`Oversized metadata ${field}`), evidence: [evidence] },
          context,
        ),
      ).toThrow(/metadata/i);
    }
    const tooMany = Array.from({ length: MAX_EVIDENCE_COUNT + 1 }, () => ({
      kind: "run" as const,
      sessionId: context.sessionId,
      runId: context.runId,
    }));
    expect(() =>
      service.proposeProjectMemory(
        { ...proposal("Too many evidence references"), evidence: tooMany },
        context,
      ),
    ).toThrow(/evidence count/i);
    expect(() =>
      service.proposeProjectMemory(
        { ...proposal("Oversized title"), title: "T".repeat(MAX_TITLE_LENGTH + 1) },
        context,
      ),
    ).toThrow(/bounds/i);
    expect(() =>
      service.proposeProjectMemory(
        { ...proposal("Oversized claim"), claim: "C".repeat(MAX_CLAIM_LENGTH + 1) },
        context,
      ),
    ).toThrow(/bounds/i);
  });

  it("rejects secret-like evidence on a dedupe hit without changing records, evidence, or events", () => {
    const input = proposal("Validated dedupe claim");
    const record = service.proposeProjectMemory(input, context);
    const counts = () => ({
      records: (
        db
          .prepare("select count(*) as count from project_memory_records where id = ?")
          .get(record.id) as { count: number }
      ).count,
      evidence: (
        db
          .prepare("select count(*) as count from project_memory_evidence where memory_id = ?")
          .get(record.id) as { count: number }
      ).count,
      events: (
        db
          .prepare("select count(*) as count from project_memory_events where memory_id = ?")
          .get(record.id) as { count: number }
      ).count,
    });
    const before = counts();
    const duplicate = {
      ...input,
      evidence: [{ kind: "task" as const, taskRef: `api_key=${"secret".repeat(8)}` }],
    };
    expect(() => service.proposeProjectMemory(duplicate, context)).toThrow(/secret/i);
    expect(counts()).toEqual(before);
  });

  it("scans every credential assignment when a placeholder precedes a real secret", () => {
    const input = proposal("Scan all credential assignments");
    const record = service.proposeProjectMemory(input, context);
    const countRows = () => ({
      records: (
        db
          .prepare("select count(*) as count from project_memory_records where id = ?")
          .get(record.id) as { count: number }
      ).count,
      evidence: (
        db
          .prepare("select count(*) as count from project_memory_evidence where memory_id = ?")
          .get(record.id) as { count: number }
      ).count,
      events: (
        db
          .prepare("select count(*) as count from project_memory_events where memory_id = ?")
          .get(record.id) as { count: number }
      ).count,
    });
    const before = countRows();
    const duplicate = {
      ...input,
      evidence: [
        { kind: "task" as const, taskRef: "api_key=redacted; api_key=ActualCredential123456789" },
      ],
    };
    expect(() => service.proposeProjectMemory(duplicate, context)).toThrow(/secret/i);
    expect(countRows()).toEqual(before);
  });

  it("bounds evidence in each DTO while retaining every source for rollback", () => {
    expect(service.PROJECT_MEMORY_EVIDENCE_DTO_LIMIT).toBe(MAX_EVIDENCE_DTO_COUNT);
    const owner = {
      ...context,
      sessionId: "session-dto-evidence",
      runId: "run-dto-initial",
      userMessageId: "msg-dto-initial",
    };
    const input = proposal(
      "Bounded evidence projection with durable rollback links",
      "project",
      "decision",
      owner,
    );
    const initial = service.proposeProjectMemory(input, owner);
    service.finalizeProjectMemoryRun({
      sessionId: owner.sessionId,
      runId: owner.runId,
      outcome: "completed",
    });

    let latestRunId = owner.runId;
    for (let index = 0; index < 40; index += 1) {
      latestRunId = `run-dto-evidence-${index}`;
      const userMessageId = `msg-dto-evidence-${index}`;
      db.prepare(
        "insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at) values (?, ?, ?, ?, ?, ?)",
      ).run(latestRunId, owner.sessionId, userMessageId, "dedupe source", "completed", "now");
      const nextOwner = { ...owner, runId: latestRunId, userMessageId };
      const duplicate = service.proposeProjectMemory(
        {
          ...input,
          evidence: [{ kind: "run", sessionId: nextOwner.sessionId, runId: latestRunId }],
        },
        nextOwner,
      );
      expect(duplicate.id).toBe(initial.id);
      expect(duplicate.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_DTO_COUNT);
    }

    const snapshot = service.getProjectMemorySnapshot("ws-legacy");
    const dto = snapshot.memories.find((memory) => memory.id === initial.id);
    expect(dto?.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_DTO_COUNT);
    expect(dto?.evidence.some((evidence) => evidence.runId === latestRunId)).toBe(true);
    expect(dto?.evidence.some((evidence) => evidence.runId === owner.runId)).toBe(false);
    expect(
      (
        db
          .prepare("select count(*) as count from project_memory_evidence where memory_id = ?")
          .get(initial.id) as { count: number }
      ).count,
    ).toBeGreaterThan(32);

    service.invalidateProjectMemoriesForRuns(owner.sessionId, [owner.runId]);
    expect(
      service
        .getProjectMemorySnapshot("ws-legacy")
        .memories.find((memory) => memory.id === initial.id)?.status,
    ).toBe("needs_review");
  });

  it("deletes records with evidence/events and cascades project records with their workspace", () => {
    const record = service.proposeProjectMemory(proposal("Delete me"), context);
    service.deleteProjectMemory(record.id);
    expect(
      db.prepare("select id from project_memory_records where id = ?").get(record.id),
    ).toBeUndefined();
    const cascade = service.proposeProjectMemory(proposal("Workspace cascade"), context);
    const global = service.proposeProjectMemory(
      proposal("Global survives project deletion", "global", "preference"),
      context,
    );
    db.prepare("delete from agent_sessions where workspace_id = ?").run("ws-legacy");
    db.prepare("delete from workspaces where id = ?").run("ws-legacy");
    expect(
      db.prepare("select id from project_memory_records where id = ?").get(cascade.id),
    ).toBeUndefined();
    expect(db.prepare("select id from project_memory_records where id = ?").get(global.id)).toEqual(
      { id: global.id },
    );
  });

  it("detaches session, run, and user-message evidence atomically when a chat is deleted", () => {
    const contextB = {
      ...context,
      workspaceId: "ws-b",
      sessionId: "session-legacy-b",
      runId: "run-b",
      userMessageId: "msg-b",
      cwd: "/b",
    };
    const record = service.proposeProjectMemory(
      proposal("Chat survives as detached evidence", "project", "decision", contextB),
      contextB,
    );
    db.prepare("delete from agent_sessions where id = ?").run(contextB.sessionId);
    const evidence = db
      .prepare(
        "select session_id, run_id, user_message_id, detached from project_memory_evidence where memory_id = ?",
      )
      .get(record.id);
    expect(evidence).toEqual({
      session_id: null,
      run_id: null,
      user_message_id: null,
      detached: 1,
    });
    expect(db.prepare("select id from project_memory_records where id = ?").get(record.id)).toEqual(
      { id: record.id },
    );
  });
});
