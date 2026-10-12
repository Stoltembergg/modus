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
