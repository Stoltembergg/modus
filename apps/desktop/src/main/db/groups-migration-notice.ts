import type { DatabaseSync } from "node:sqlite";
import type { GroupsMigrationNotice } from "../../shared/contracts";
import { GROUPS_MIGRATION_MARKER, isGroupsMigrationDone } from "./groups-to-projects";

export const GROUPS_MIGRATION_NOTICE_SHOWN = `${GROUPS_MIGRATION_MARKER}.notice_shown`;

/**
 * `migrated` is true once the marker is done (renderer clears old room drafts
 * then). `show` is true only once, and only when at least one group moved.
 */
export function readGroupsMigrationNotice(db: DatabaseSync): GroupsMigrationNotice {
  if (!isGroupsMigrationDone(db)) return { migrated: false, show: false, groups: [], backup: null };
  const marker = db
    .prepare("select value from app_settings where key = ?")
    .get(GROUPS_MIGRATION_MARKER) as { value: string };
  const parsed = JSON.parse(marker.value) as { backup?: string | null };
  const shown = db
    .prepare("select 1 from app_settings where key = ?")
    .get(GROUPS_MIGRATION_NOTICE_SHOWN);
  const groups = db
    .prepare(
      `select t.group_id as groupId, t.session_id as sessionId, s.title as title,
              s.workspace_id as workspaceId
         from migrated_group_transcripts t join agent_sessions s on s.id = t.session_id
        order by s.created_at, t.group_id`,
    )
    .all() as GroupsMigrationNotice["groups"];
  return {
    migrated: true,
    show: !shown && groups.length > 0,
    groups,
    backup: parsed.backup ?? null,
  };
}

export function dismissGroupsMigrationNotice(
  db: DatabaseSync,
  now = new Date().toISOString(),
): void {
  db.prepare(
    `insert into app_settings (key, value, updated_at) values (?, '1', ?)
     on conflict(key) do update set value = '1', updated_at = excluded.updated_at`,
  ).run(GROUPS_MIGRATION_NOTICE_SHOWN, now);
}

/** The Markdown transcript of a migrated room chat, or null for any other session. */
export function readMigratedGroupTranscript(db: DatabaseSync, sessionId: string): string | null {
  const row = db
    .prepare("select body_md from migrated_group_transcripts where session_id = ?")
    .get(sessionId) as { body_md: string } | undefined;
  return row?.body_md ?? null;
}
