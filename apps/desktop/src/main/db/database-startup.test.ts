import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));

const { DatabaseTooNewError } = await import("./database");
const { DATABASE_TOO_NEW_TITLE, openDatabaseAtStartup } = await import("./database-startup");

describe("openDatabaseAtStartup", () => {
  it("opens and lets boot continue", () => {
    const deps = { open: vi.fn(), showErrorBox: vi.fn(), quit: vi.fn() };
    expect(openDatabaseAtStartup(deps)).toBe(true);
    expect(deps.showErrorBox).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it("a too-new file shows an error box with the path and guidance, then quits", () => {
    const deps = {
      open: vi.fn(() => {
        throw new DatabaseTooNewError(1, "/data/modus.sqlite");
      }),
      showErrorBox: vi.fn(),
      quit: vi.fn(),
    };
    expect(openDatabaseAtStartup(deps)).toBe(false);
    expect(deps.showErrorBox).toHaveBeenCalledWith(
      DATABASE_TOO_NEW_TITLE,
      expect.stringContaining("/data/modus.sqlite"),
    );
    const message = deps.showErrorBox.mock.calls[0]?.[1] as string;
    expect(message).toMatch(/reinstall the newer Modus/);
    expect(message).toMatch(/backup/);
    expect(message).toContain("/data/backups/modus-*-pre-groups.db");
    expect(message).not.toContain("modus.sqlite.backup");
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it("other errors propagate to the boot catch", () => {
    const deps = {
      open: vi.fn(() => {
        throw new Error("disk");
      }),
      showErrorBox: vi.fn(),
      quit: vi.fn(),
    };
    expect(() => openDatabaseAtStartup(deps)).toThrow("disk");
    expect(deps.showErrorBox).not.toHaveBeenCalled();
  });
});

describe("openDatabaseAtStartup: groups migration failure", async () => {
  const { GroupsMigrationError } = await import("./database");
  const failure = () => new GroupsMigrationError("verify failed", 3, "/data/backups/b.db", true);

  it("shows the migration-error screen; Try again forces a re-run and boot continues", () => {
    let calls = 0;
    const open = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw failure();
    });
    const showMigrationError = vi.fn(() => "retry" as const);
    const deps = { open, showErrorBox: vi.fn(), quit: vi.fn(), showMigrationError };
    expect(openDatabaseAtStartup(deps)).toBe(true);
    expect(open).toHaveBeenNthCalledWith(2, { forceGroupsMigration: true });
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it("Show backup reveals the backup and asks again; Quit exits", () => {
    const choices = ["backup", "quit"] as const;
    let i = 0;
    const deps = {
      open: vi.fn(() => {
        throw failure();
      }),
      showErrorBox: vi.fn(),
      quit: vi.fn(),
      showMigrationError: vi.fn(() => choices[i++] ?? "quit"),
      showBackup: vi.fn(),
    };
    expect(openDatabaseAtStartup(deps)).toBe(false);
    expect(deps.showBackup).toHaveBeenCalledWith("/data/backups/b.db");
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it("without a screen, falls back to an error box that says nothing was lost", async () => {
    const { GROUPS_MIGRATION_ERROR_TITLE } = await import("./database-startup");
    const deps = {
      open: vi.fn(() => {
        throw failure();
      }),
      showErrorBox: vi.fn(),
      quit: vi.fn(),
    };
    expect(openDatabaseAtStartup(deps)).toBe(false);
    expect(deps.showErrorBox).toHaveBeenCalledWith(
      GROUPS_MIGRATION_ERROR_TITLE,
      expect.stringMatching(/Nothing was lost[\s\S]*b\.db[\s\S]*paused after 3/),
    );
  });
});
