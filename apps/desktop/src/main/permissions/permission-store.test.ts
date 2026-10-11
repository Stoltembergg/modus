import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeApprovalCwd } from "./permission-store";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase, migrateDatabase } = await import("../db/database");
const { findWorkspaceAllowDecision, recordPermissionDecision } = await import("./permission-store");

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-permission-store-test-"));
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("normalizeApprovalCwd", () => {
  it("normalizes separators and strips trailing slashes", () => {
    const a = normalizeApprovalCwd("F:\\CodeHub\\modus\\");
    const b = normalizeApprovalCwd("F:/CodeHub/modus");
    expect(a).toBe(b);
    expect(a.includes("\\")).toBe(false);
    expect(a.endsWith("/")).toBe(false);
  });
});

describe("workspace permission grants", () => {
  it("scopes saved grants to their workspace and tool identity", () => {
    const database = getDatabase();
    const now = new Date().toISOString();
    for (const id of ["permission-workspace-a", "permission-workspace-b"]) {
      database
        .prepare(
          `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
           values (?, ?, 'test', 0, ?, ?)`,
        )
        .run(id, `/${id}`, now, now);
    }

    const decision = recordPermissionDecision("mcp.call", '{"input":1}', "allow-workspace", {
      workspaceId: "permission-workspace-a",
      toolName: "mcp_server_first_tool",
    });

    expect(decision.decision).toBe("allow-workspace");
    expect(
      findWorkspaceAllowDecision(
        "mcp.call",
        '{"input":1}',
        "permission-workspace-a",
        "mcp_server_first_tool",
      ),
    ).toBeDefined();
    expect(
      findWorkspaceAllowDecision(
        "mcp.call",
        '{"input":1}',
        "permission-workspace-b",
        "mcp_server_first_tool",
      ),
    ).toBeUndefined();
    expect(
      findWorkspaceAllowDecision(
        "mcp.call",
        '{"input":1}',
        "permission-workspace-a",
        "mcp_server_second_tool",
      ),
    ).toBeUndefined();
  });

  it("refuses unscoped workspace grants", () => {
    expect(() =>
      recordPermissionDecision("shell.execute", "git clean -f", "allow-workspace"),
    ).toThrow("Workspace and tool identity are required for workspace grants.");
  });

  it("does not merge grants for targets that differ inside quoted whitespace", () => {
    const database = getDatabase();
    const workspaceId = "permission-whitespace-workspace";
    const now = new Date().toISOString();
    database
      .prepare(
        `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
         values (?, ?, 'test', 0, ?, ?)`,
      )
      .run(workspaceId, `/${workspaceId}`, now, now);
    const approvedCommand = "printf '%s' 'two  spaces'";

    recordPermissionDecision("shell.execute", approvedCommand, "allow-workspace", {
      workspaceId,
      toolName: "bash",
    });

    expect(
      findWorkspaceAllowDecision("shell.execute", approvedCommand, workspaceId, "bash"),
    ).toBeDefined();
    expect(
      findWorkspaceAllowDecision("shell.execute", "printf '%s' 'two spaces'", workspaceId, "bash"),
    ).toBeUndefined();
  });

  it("keeps legacy permission rows unscoped during migration", () => {
    const legacy = new DatabaseSync(":memory:");
    legacy.exec(`
      create table permissions (
        id text primary key,
        action text not null,
        target text not null,
        decision text not null,
        created_at text not null
      );
      insert into permissions values ('legacy', 'shell.execute', 'npm test', 'allow-workspace', '2025-01-01T00:00:00.000Z');
    `);

    migrateDatabase(legacy);

    const columns = legacy.prepare("pragma table_info(permissions)").all() as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).toContain("workspace_id");
    expect(columns.map(({ name }) => name)).toContain("tool_name");
    expect(
      legacy.prepare("select workspace_id, tool_name from permissions where id = 'legacy'").get(),
    ).toEqual({ workspace_id: null, tool_name: null });
  });
});
