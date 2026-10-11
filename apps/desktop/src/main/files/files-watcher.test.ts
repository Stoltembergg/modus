import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  send: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: mocks.watch,
}));
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
}));
vi.mock("../groups/group-project-setup", () => ({
  notifyGroupProjectPathsChanged: vi.fn(),
}));

import { IPC_CHANNELS } from "../ipc/channels";
import { isWorkspaceWatched, unwatchWorkspace, watchWorkspace } from "./files-watcher";

describe("workspace watcher status", () => {
  beforeEach(() => {
    mocks.watch.mockReset();
    mocks.send.mockReset();
  });

  it("reports failed watcher creation as unavailable", () => {
    const cwd = resolve(process.cwd(), "watch-startup-failure");
    mocks.watch.mockImplementationOnce(() => {
      throw new Error("watch unsupported");
    });

    expect(watchWorkspace(cwd)).toBe(cwd);
    expect(isWorkspaceWatched(cwd)).toBe(false);
    unwatchWorkspace(cwd);
  });

  it("notifies subscribers and reports unavailable when an active watcher fails", () => {
    const cwd = resolve(process.cwd(), "watch-runtime-failure");
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    mocks.watch.mockReturnValueOnce(watcher);

    expect(watchWorkspace(cwd)).toBe(cwd);
    expect(isWorkspaceWatched(cwd)).toBe(true);

    watcher.emit("error", new Error("watch dropped"));

    expect(isWorkspaceWatched(cwd)).toBe(false);
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith(
      IPC_CHANNELS.filesEvent,
      expect.objectContaining({ cwd, paths: [], watching: false }),
    );
    unwatchWorkspace(cwd);
  });
});
