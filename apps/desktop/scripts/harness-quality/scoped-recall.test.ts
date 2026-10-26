import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDatabase } from "../../src/main/db/database";
import {
  buildScopedRecallContext,
  SCOPED_RECALL_FIXTURE,
  seedScopedRecallEvaluationMemories,
} from "./scoped-recall";

const { userDataPath } = vi.hoisted(() => ({ userDataPath: { current: "" } }));
vi.mock("electron", () => ({ app: { getPath: () => userDataPath.current } }));

let root = "";
let workspaceId = "";
let decoyWorkspaceId = "";
let expectedMemoryId = "";
let decoyMemoryId = "";
let database: ReturnType<typeof getDatabase>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "modus-scoped-recall-"));
  userDataPath.current = join(root, "userdata");
  mkdirSync(userDataPath.current, { recursive: true });
  database = getDatabase();
  const now = new Date().toISOString();
  const insertWorkspace = database.prepare(`insert into workspaces
    (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
    values (?, ?, ?, 0, ?, ?)`);
  workspaceId = "quality-recall-current-workspace";
  decoyWorkspaceId = "quality-recall-other-workspace";
  insertWorkspace.run(workspaceId, join(root, "current"), "Current", now, now);
  insertWorkspace.run(decoyWorkspaceId, join(root, "other"), "Other", now, now);
  ({ expectedMemoryId, decoyMemoryId } = seedScopedRecallEvaluationMemories({
    workspaceId,
    decoyWorkspaceId,
  }));
});

afterAll(() => {
  database?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("scoped local-memory recall extension", () => {
  it("uses the real memory store and context planner while excluding a same-topic other workspace", async () => {
    const digest = await buildScopedRecallContext(workspaceId, "quality-recall-session");
    expect(digest.memoryIds).toContain(expectedMemoryId);
    expect(digest.memoryIds).not.toContain(decoyMemoryId);
    expect(digest.text).toContain("partial refund webhook");
    expect(digest.text).not.toContain("cross-workspace decoy");
  });

  it("keeps the independent answer verifier outside the model prompt", () => {
    expect(SCOPED_RECALL_FIXTURE.id).toBe("scoped-refund-recall-en");
    expect(SCOPED_RECALL_FIXTURE.writable).toEqual(["answer.json"]);
    expect(SCOPED_RECALL_FIXTURE.prompt).not.toContain("cross-workspace decoy");
    expect(
      SCOPED_RECALL_FIXTURE.verify({
        files: {
          ...SCOPED_RECALL_FIXTURE.files,
          "answer.json":
            '{"status":"pending","reversalCreated":false,"idempotencyKey":"provider_event_id"}',
        },
        childSessions: 0,
        successfulWaits: 0,
      }).every(({ passed }) => passed),
    ).toBe(true);
  });
});
