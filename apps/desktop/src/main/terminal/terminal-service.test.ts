import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostMocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: hostMocks.spawn }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../db/database", () => ({
  getDatabase: () => ({ prepare: () => ({ run: vi.fn(), get: vi.fn(), all: vi.fn() }) }),
}));
vi.mock("../process/managed-process-bus", () => ({ publishManagedProcessChange: vi.fn() }));

import { listTerminals, runAgentCommand } from "./terminal-service";

describe("terminal-service run cancellation", () => {
  let commands: Array<{ type: string; id?: string }>;
  const originalHostPath = process.env.MODUS_PTY_HOST_PATH;

  beforeEach(() => {
    process.env.MODUS_PTY_HOST_PATH = process.execPath;
    commands = [];
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = {
      write: (line: string): boolean => {
        const command = JSON.parse(line) as { type: string; id?: string };
        commands.push(command);
        if (command.type === "spawn" && command.id) {
          stdout.emit(
            "data",
            Buffer.from(`${JSON.stringify({ type: "spawned", id: command.id, pid: 42 })}\n`),
          );
        }
        if (command.type === "kill" && command.id) {
          stdout.emit(
            "data",
            Buffer.from(`${JSON.stringify({ type: "exit", id: command.id, exit_code: 143 })}\n`),
          );
        }
        return true;
      },
    };
    const host = Object.assign(new EventEmitter(), {
      killed: false,
      stdin,
      stdout,
      stderr,
    });
    hostMocks.spawn.mockReturnValue(host as never);
  });

  afterEach(() => {
    if (originalHostPath === undefined) delete process.env.MODUS_PTY_HOST_PATH;
    else process.env.MODUS_PTY_HOST_PATH = originalHostPath;
  });

  it("kills a newly started background terminal when its tool signal aborts", async () => {
    const controller = new AbortController();
    const run = runAgentCommand({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "node -e 'setTimeout(() => {}, 1000)'",
      background: true,
      sessionId: "session-a",
      runId: "run-a",
      yieldMs: 5_000,
      signal: controller.signal,
    });
    const spawn = commands.find((command) => command.type === "spawn");
    expect(spawn?.id).toBeDefined();

    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(commands).toContainEqual({ type: "kill", id: spawn?.id });
    expect(listTerminals()).toContainEqual(
      expect.objectContaining({
        id: spawn?.id,
        sessionId: "session-a",
        runId: "run-a",
        status: "exited",
      }),
    );
  });
});
