import { DatabaseTooNewError } from "./database";

export type DatabaseStartupDeps = {
  open(): unknown;
  showErrorBox(title: string, content: string): void;
  quit(): void;
};

export const DATABASE_TOO_NEW_TITLE = "Modus can't open your data";

export function databaseTooNewMessage(error: DatabaseTooNewError): string {
  return [
    `Your Modus data (${error.dbPath || "modus.sqlite"}) was upgraded by a newer version of Modus (schema ${error.version}).`,
    "This version can't read it, and it has not changed the file.",
    "To continue, reinstall the newer Modus. Or quit Modus and restore the backup copy of that file made before the upgrade (modus.sqlite.backup-* next to it, if present).",
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
