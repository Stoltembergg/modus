import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  commands: string[];
};

function createFakeChild(options: { respond?: boolean; start?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.commands = [];
  child.kill = vi.fn(() => {
    child.stdin.destroy();
    child.stdout.end();
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    return true;
  });
  let input = "";
  child.stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    const lines = input.split("\n");
    input = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      child.commands.push(line);
      if (options.respond === false) continue;
      const envelope = JSON.parse(line) as { type: string; request?: { requestId: string } };
      if (envelope.type !== "invoke" || !envelope.request) continue;
      child.stdout.write(
        `${JSON.stringify({
          status: "denied",
          requestId: envelope.request.requestId,
          reason: "Linux process isolation is not implemented; worker admission is denied.",
        })}\n`,
      );
    }
  });
  child.stdin.once("finish", () => {
    child.stdout.end();
    child.emit("close", 0, null);
  });
  if (options.start === true) queueMicrotask(() => child.emit("spawn"));
  return child;
}

describe("LinuxPluginWorkerSupervisor", () => {
  let priorCwd: string | undefined;
  let fixtureDirectory: string | undefined;
  const supervisors: LinuxPluginWorkerSupervisor[] = [];

  async function prepareSupervisorPath(prefix: string): Promise<string> {
    priorCwd = process.cwd();
    fixtureDirectory = await mkdtemp(join(tmpdir(), prefix));
    process.chdir(fixtureDirectory);
    const binaryPath = join(
      fixtureDirectory,
      "target",
      "release",
      "modus-plugin-execution-supervisor",
    );
    await mkdir(join(fixtureDirectory, "target", "release"), { recursive: true });
    await writeFile(binaryPath, "synthetic supervisor placeholder");
    return binaryPath;
  }

  function newSupervisor(): LinuxPluginWorkerSupervisor {
    const supervisor = new LinuxPluginWorkerSupervisor();
    supervisors.push(supervisor);
    return supervisor;
  }

  afterEach(async () => {
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()));
    spawnMock.mockReset();
    if (priorCwd) process.chdir(priorCwd);
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
    priorCwd = undefined;
    fixtureDirectory = undefined;
  });

  it.skipIf(process.platform !== "linux")(
    "uses bounded correlated line IPC and returns the supervisor denial",
    async () => {
      const binaryPath = await prepareSupervisorPath("modus-linux-supervisor-test-");
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);
      const supervisor = newSupervisor();
      const pending = supervisor.execute(request);
      child.emit("spawn");
      await expect(pending).rejects.toThrow(
        "Linux process isolation is not implemented; worker admission is denied.",
      );

      expect(spawnMock).toHaveBeenCalledOnce();
      expect(spawnMock).toHaveBeenCalledWith(
        binaryPath,
        [],
        expect.objectContaining({ shell: false, stdio: ["pipe", "pipe", "ignore"] }),
      );
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reuses one persistent supervisor for concurrent authorized requests",
    async () => {
      await prepareSupervisorPath("modus-linux-supervisor-shared-");
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);
      const supervisor = newSupervisor();
      const requests = [
        supervisor.execute(request),
        supervisor.execute({ ...request, requestId: "fixture-request-2", runId: "fixture-run-2" }),
      ];
      child.emit("spawn");

      const results = await Promise.allSettled(requests);
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      expect(spawnMock).toHaveBeenCalledOnce();
      expect(child.stdin.writable).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "invalidates all pending operations on cancellation without an in-process fallback",
    async () => {
      await prepareSupervisorPath("modus-linux-supervisor-cancel-");
      const child = createFakeChild({ respond: false });
      spawnMock.mockReturnValue(child);
      const supervisor = newSupervisor();
      const controller = new AbortController();
      const pending = supervisor.execute(request, controller.signal);
      const concurrent = supervisor.execute({ ...request, requestId: "fixture-request-2" });
      child.emit("spawn");
      await vi.waitFor(() => expect(child.commands).toHaveLength(2));
      controller.abort(new Error("fixture cancellation"));

      await expect(pending).rejects.toThrow("fixture cancellation");
      await expect(concurrent).rejects.toThrow("fixture cancellation");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(spawnMock).toHaveBeenCalledOnce();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rejects startup failures without retrying through another execution path",
    async () => {
      await prepareSupervisorPath("modus-linux-supervisor-start-failure-");
      const child = createFakeChild({ start: false });
      spawnMock.mockReturnValue(child);
      const supervisor = newSupervisor();
      const pending = supervisor.execute(request);
      child.emit("error", new Error("synthetic spawn failure"));

      await expect(pending).rejects.toThrow("Unable to start Linux plugin supervisor");
      expect(spawnMock).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "invalidates the process and rejects pending work when an IPC deadline expires",
    async () => {
      vi.useFakeTimers();
      try {
        await prepareSupervisorPath("modus-linux-supervisor-timeout-");
        const child = createFakeChild({ respond: false });
        spawnMock.mockReturnValue(child);
        const supervisor = newSupervisor();
        const pending = supervisor.execute(request);
        child.emit("spawn");
        const pendingFailure = expect(pending).rejects.toThrow("exceeded its request deadline");
        await vi.advanceTimersByTimeAsync(0);
        expect(child.commands).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(10_001);

        await pendingFailure;
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "restarts after unexpected supervisor exit and never retries the failed invocation",
    async () => {
      await prepareSupervisorPath("modus-linux-supervisor-restart-");
      const first = createFakeChild({ respond: false });
      const second = createFakeChild();
      spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
      const supervisor = newSupervisor();
      const pending = supervisor.execute(request);
      first.emit("spawn");
      await vi.waitFor(() => expect(first.commands).toHaveLength(1));
      first.emit("close", 1, null);
      await expect(pending).rejects.toThrow("exited with status 1");

      const next = supervisor.execute({ ...request, requestId: "later-request" });
      second.emit("spawn");
      await expect(next).rejects.toThrow(
        "Linux process isolation is not implemented; worker admission is denied.",
      );
      expect(spawnMock).toHaveBeenCalledTimes(2);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "releases session provenance and closes idempotently on runtime shutdown",
    async () => {
      await prepareSupervisorPath("modus-linux-supervisor-release-");
      const child = createFakeChild();
      const lines: string[] = [];
      let input = "";
      child.stdin.on("data", (chunk: Buffer) => {
        input += chunk.toString("utf8");
        const split = input.split("\n");
        input = split.pop() ?? "";
        lines.push(...split.filter(Boolean));
      });
      // Reattach invocation responses after recording the same input stream.
      child.stdout.on("close", () => undefined);
      spawnMock.mockReturnValue(child);
      const supervisor = newSupervisor();
      const pending = supervisor.execute(request);
      child.emit("spawn");
      await expect(pending).rejects.toThrow("worker admission is denied");
      await supervisor.releaseSession(request.sessionId);
      await supervisor.close();
      await supervisor.close();

      expect(lines.some((line) => JSON.parse(line).type === "release_session")).toBe(true);
      expect(child.stdin.writableEnded).toBe(true);
      await expect(supervisor.execute({ ...request, requestId: "after-shutdown" })).rejects.toThrow(
        "shutting down",
      );
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rejects changed provenance within an active session before sending another request",
    async () => {
      await prepareSupervisorPath("modus-linux-supervisor-provenance-");
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);
      const supervisor = newSupervisor();
      const pending = supervisor.execute(request);
      child.emit("spawn");
      await expect(pending).rejects.toThrow("worker admission is denied");
      await expect(
        supervisor.execute({ ...request, requestId: "changed", workspaceId: "other-workspace" }),
      ).rejects.toThrow("provenance changed");
      expect(spawnMock).toHaveBeenCalledOnce();
    },
  );

  it.skipIf(process.platform === "linux")(
    "blocks supervisor execution on non-Linux platforms before spawning",
    async () => {
      await expect(newSupervisor().execute(request)).rejects.toThrow(
        `External plugin execution is blocked on ${process.platform}.`,
      );
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );
});
