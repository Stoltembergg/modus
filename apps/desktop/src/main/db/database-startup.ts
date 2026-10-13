import { dirname, join } from "node:path";
import { DatabaseTooNewError, GroupsMigrationError } from "./database";

export type DatabaseStartupDeps = {
  /** `force` re-runs the groups migration even after automatic retries stopped. */
  open(options?: { forceGroupsMigration?: boolean }): unknown;
  /**
   * The migration-error screen (plan §2.4): returns the button the user chose.
   * Optional so callers without a UI fall back to the error box + quit.
   */
  showMigrationError?(error: GroupsMigrationError): "retry" | "backup" | "quit";
  showBackup?(path: string | null): void;
  showErrorBox(title: string, content: string): void;
  quit(): void;
};

export const DATABASE_TOO_NEW_TITLE = "Modus can't open your data";

/** The pre-migration backup (plan §2.5): <userData>/backups/modus-*-pre-groups.db. */
export function backupPattern(dbPath: string): string {
  const dir = dbPath ? dirname(dbPath) : "<userData>";
  return join(dir, "backups", "modus-*-pre-groups.db");
}

export function databaseTooNewMessage(error: DatabaseTooNewError): string {
  return [
    `Your Modus data (${error.dbPath || "modus.sqlite"}) was upgraded by a newer version of Modus (schema ${error.version}).`,
    "This version can't read it, and it has not changed the file.",
    `To continue, reinstall the newer Modus. Or quit Modus and restore the backup made before the upgrade: ${backupPattern(error.dbPath)} (copy it over the file above).`,
  ].join("\n\n");
}

/**
 * First DB open, at the very start of whenReady (before any window or IPC
 * call can open it). A too-new file shows a clear error box and quits; any
 * other error propagates to the boot catch. Returns whether boot may go on.
 */
export const GROUPS_MIGRATION_ERROR_TITLE = "Modus couldn't move your groups to Projects";

export function groupsMigrationErrorMessage(error: GroupsMigrationError): string {
  return [
    "Nothing was lost: your groups, agents and chats are exactly as they were, and the change was rolled back.",
    `Details: ${error.message}`,
    error.backup ? `A backup was saved at ${error.backup}.` : "",
    error.autoRetryStopped
      ? `Automatic retries are paused after ${error.attempts} attempts. Choose Try again to run it once more.`
      : "Choose Try again to run it again.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * First DB open, at the very start of whenReady (before any window or IPC
 * call can open it). A too-new file shows a clear error box and quits; a
 * failed groups migration shows the migration-error screen (Try again / Show
 * backup / Quit); any other error propagates to the boot catch. Returns
 * whether boot may go on.
 */
export function openDatabaseAtStartup(deps: DatabaseStartupDeps): boolean {
  let force = false;
  for (;;) {
    try {
      deps.open(force ? { forceGroupsMigration: true } : undefined);
      return true;
    } catch (error) {
      if (error instanceof DatabaseTooNewError) {
        deps.showErrorBox(DATABASE_TOO_NEW_TITLE, databaseTooNewMessage(error));
        deps.quit();
        return false;
      }
      if (!(error instanceof GroupsMigrationError)) throw error;
      if (!deps.showMigrationError) {
        deps.showErrorBox(GROUPS_MIGRATION_ERROR_TITLE, groupsMigrationErrorMessage(error));
        deps.quit();
        return false;
      }
      const choice = deps.showMigrationError(error);
      if (choice === "retry") {
        force = true;
        continue;
      }
      if (choice === "backup") {
        deps.showBackup?.(error.backup);
        continue;
      }
      deps.quit();
      return false;
    }
  }
}
