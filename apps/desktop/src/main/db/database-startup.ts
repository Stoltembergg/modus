import { dirname, join } from "node:path";
import { DatabaseTooNewError } from "./database";

export type DatabaseStartupDeps = {
  open(): unknown;
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
export function openDatabaseAtStartup(deps: DatabaseStartupDeps): boolean {
  try {
    deps.open();
    return true;
  } catch (error) {
    if (!(error instanceof DatabaseTooNewError)) throw error;
    deps.showErrorBox(DATABASE_TOO_NEW_TITLE, databaseTooNewMessage(error));
    deps.quit();
    return false;
  }
}
