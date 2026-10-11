import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("electron", () => ({ app: { isPackaged: false } }));

import { LinuxPluginWorkerSupervisor } from "./linux-plugin-worker-supervisor";

const request = {
  requestId: "fixture-request",
  pluginId: "fixture/plugin",
  pluginVersion: "1.0.0",
  artifactSha256: "a".repeat(64),
  artifactOrigin: "fixture-host-catalog",
  trustLevel: "verified" as const,
  generation: 1,
  hostGrantedCapabilities: ["memory.read"],
  sessionId: "fixture-session",
  workspaceId: "fixture-workspace",
  runId: "fixture-run",
  capability: "plugin.transform",
  payload: { text: "synthetic" },
};

describe("LinuxPluginWorkerSupervisor", () => {
  let priorCwd: string | undefined;
  let fixtureDirectory: string | undefined;

  afterEach(async () => {
    spawnMock.mockReset();
    if (priorCwd) process.chdir(priorCwd);
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
    priorCwd = undefined;
    fixtureDirectory = undefined;
  });

  it.skipIf(process.platform !== "linux")(
    "uses bounded JSON IPC to the supervisor and returns only its correlated denial",
    async () => {
      priorCwd = process.cwd();
      fixtureDirectory = await mkdtemp(join(tmpdir(), "modus-linux-supervisor-test-"));
      process.chdir(fixtureDirectory);
      const binaryPath = join(
        fixtureDirectory,
        "target",
        "release",
        "modus-plugin-execution-supervisor",
      );
      await mkdir(join(fixtureDirectory, "target", "release"), { recursive: true });
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = vi.fn(() => true);
      const sent: Buffer[] = [];
      child.stdin.on("data", (chunk: Buffer) => sent.push(Buffer.from(chunk)));
      child.stdin.once("finish", () => {
        const envelope = JSON.parse(Buffer.concat(sent).toString("utf8")) as { requestId: string };
        child.stdout.end(
          JSON.stringify({
            status: "denied",
            requestId: envelope.requestId,
            reason: "Linux process isolation is not implemented; worker admission is denied.",
          }),
          () => child.emit("close", 0, null),
        );
      });
      spawnMock.mockReturnValue(child);

      // The path lookup only checks presence; spawn remains a synthetic mock.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(binaryPath, "synthetic supervisor placeholder");
      const supervisor = new LinuxPluginWorkerSupervisor();
      await expect(supervisor.execute(request)).rejects.toThrow(
        "Linux process isolation is not implemented; worker admission is denied.",
      );

      expect(spawnMock).toHaveBeenCalledWith(
        binaryPath,
        [],
        expect.objectContaining({ shell: false, stdio: ["pipe", "pipe", "ignore"] }),
      );
      expect(spawnMock.mock.calls[0]?.[2]).not.toHaveProperty("shell", true);
      expect(JSON.parse(Buffer.concat(sent).toString("utf8"))).toEqual(request);
      expect(child.kill).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "kills the supervisor request on cancellation without an in-process fallback",
    async () => {
      priorCwd = process.cwd();
      fixtureDirectory = await mkdtemp(join(tmpdir(), "modus-linux-supervisor-cancel-"));
      process.chdir(fixtureDirectory);
      await mkdir(join(fixtureDirectory, "target", "release"), { recursive: true });
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = vi.fn(() => true);
      spawnMock.mockReturnValue(child);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        join(fixtureDirectory, "target", "release", "modus-plugin-execution-supervisor"),
        "synthetic supervisor placeholder",
      );
      const controller = new AbortController();
      const pending = new LinuxPluginWorkerSupervisor().execute(request, controller.signal);
      controller.abort(new Error("fixture cancellation"));

      await expect(pending).rejects.toThrow("fixture cancellation");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it.skipIf(process.platform === "linux")(
    "blocks supervisor execution on non-Linux platforms before spawning",
    async () => {
      await expect(new LinuxPluginWorkerSupervisor().execute(request)).rejects.toThrow(
        `External plugin execution is blocked on ${process.platform}.`,
      );
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );
});
