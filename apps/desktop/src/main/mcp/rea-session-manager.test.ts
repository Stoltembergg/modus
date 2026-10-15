import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReaPrerequisiteResult } from "./rea-prerequisites";
import {
  MAX_REA_CATALOG_PAGE_SIZE,
  MAX_REA_RESULT_BYTES,
  MAX_REA_WORKERS,
  REA_OPERATION_TIMEOUT_MS,
  REA_QUEUED_CALLS_PER_WORKER,
  REA_STARTUP_TIMEOUT_MS,
  ReaSessionManager,
  type ReaSessionOwner,
} from "./rea-session-manager";
import { ReaSettingsStore } from "./rea-settings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(
  options: {
    connect?: () => Promise<void>;
    listTools?: () => Promise<{
      tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      nextCursor?: string;
    }>;
    callTool?: (name: string) => Promise<unknown>;
    startupTimeoutMs?: number;
    operationTimeoutMs?: number;
    catalogTimeoutMs?: number;
    platform?: NodeJS.Platform;
    transportPid?: number;
    transportClose?: (index: number) => Promise<void>;
    platformProcessOps?: { killTree: (pid: number) => Promise<void> | void };
    settingsStore?: ReaSettingsStore;
    checkPrerequisites?: () => Promise<ReaPrerequisiteResult>;
    transportStderr?: boolean;
    removeWorkerDirectory?: (directory: string) => void;
  } = {},
) {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const clients: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const transports: Array<{
    close: ReturnType<typeof vi.fn>;
    pid: number | null;
    onclose: (() => void) | undefined;
    emitClose: () => void;
  }> = [];
  const transportParameters: Array<Record<string, unknown>> = [];
  const stderrListeners: Array<Array<(chunk: unknown) => void>> = [];
  const userDataDirectory = mkdtempSync(join(tmpdir(), "rea-manager-userdata-"));
  testDataDirectories.push(userDataDirectory);
  const manager = new ReaSessionManager({
    supervisorPath: "fake-rea-supervisor",
    userDataDirectory,
    ...(options.startupTimeoutMs !== undefined
      ? { startupTimeoutMs: options.startupTimeoutMs }
      : {}),
    ...(options.catalogTimeoutMs !== undefined
      ? { catalogTimeoutMs: options.catalogTimeoutMs }
      : {}),
    ...(options.operationTimeoutMs !== undefined
      ? { operationTimeoutMs: options.operationTimeoutMs }
      : {}),
    platform: options.platform ?? "win32",
    ...(options.settingsStore ? { settingsStore: options.settingsStore } : {}),
    ...(options.platformProcessOps ? { platformProcessOps: options.platformProcessOps } : {}),
    checkPrerequisites: options.checkPrerequisites ?? (async () => ({ ok: true })),
    ...(options.removeWorkerDirectory
      ? { removeWorkerDirectory: options.removeWorkerDirectory }
      : {}),
    clientFactory: () => {
      const client = {
        connect: vi.fn(options.connect ?? (async () => {})),
        listTools: vi.fn(options.listTools ?? (async () => ({ tools: [{ name: "echo" }] }))),
        callTool: vi.fn(async (request: { name: string; arguments?: Record<string, unknown> }) => {
          calls.push(request);
          return (
            (await options.callTool?.(request.name)) ?? {
              content: [{ type: "text", text: request.name }],
            }
          );
        }),
        close: vi.fn(async () => {}),
      };
      clients.push(client);
      return client as never;
    },
    transportFactory: (parameters) => {
      const index = transports.length;
      const transport = {
        pid: options.transportPid ?? 5000 + index,
        onclose: undefined as (() => void) | undefined,
        stderr: options.transportStderr
          ? {
              on: (event: string, handler: (chunk: unknown) => void) => {
                if (event !== "data") return;
                const listeners = stderrListeners[index];
                if (listeners) listeners.push(handler);
                else stderrListeners[index] = [handler];
              },
            }
          : undefined,
        close: vi.fn(async () => {
          await options.transportClose?.(index);
          transport.onclose?.();
        }),
        emitClose: () => transport.onclose?.(),
      };
      transports.push(transport);
      transportParameters.push(parameters as unknown as Record<string, unknown>);
      return transport as never;
    },
  });
  const emitStderr = (index: number, text: string) => {
    for (const handler of stderrListeners[index] ?? []) handler(text);
  };
  return {
    manager,
    clients,
    transports,
    transportParameters,
    calls,
    userDataDirectory,
    emitStderr,
  };
}

const owner = (sessionId: string, generation = "g1"): ReaSessionOwner => ({
  sessionId,
  generation,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of testDataDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const testDataDirectories: string[] = [];

describe("ReaSessionManager", () => {
  it("reports curated provider limitations from host platform and configuration presence only", async () => {
    const environmentKeys = ["REA_IDA_MCP_CONFIG", "REA_JADX_MCP_JAR"] as const;
    const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    try {
      delete process.env.REA_IDA_MCP_CONFIG;
      delete process.env.REA_JADX_MCP_JAR;
      const windows = setup({ platform: "win32" });
      const windowsStatus = windows.manager.getIntegrationStatus();
      expect(windowsStatus.providerNotes).toEqual([
        "Ghidra provider is unsupported on this host.",
        "IDA provider requires a user installation and configuration.",
        "JADX provider requires a user installation and configuration.",
      ]);
      expect(JSON.stringify(windowsStatus)).not.toContain(windows.userDataDirectory);
      expect(windowsStatus.providerNotes.join(" ")).not.toMatch(/(?:[A-Z]:\\|\/home\/|\/Users\/)/);

      const settingsHome = mkdtempSync(join(tmpdir(), "rea-provider-settings-"));
      testDataDirectories.push(settingsHome);
      const settingsStore = new ReaSettingsStore(settingsHome);
      settingsStore.setEnabled(false);
      const disabled = setup({ platform: "win32", settingsStore });
      expect(disabled.manager.getIntegrationStatus()).toMatchObject({
        enabled: false,
        status: "disabled",
        providerNotes: windowsStatus.providerNotes,
      });
      mkdirSync(join(settingsHome, ".modus"), { recursive: true });
      writeFileSync(settingsStore.filePath, "{broken", "utf8");
      expect(disabled.manager.getIntegrationStatus()).toMatchObject({
        enabled: false,
        status: "failed",
        providerNotes: windowsStatus.providerNotes,
      });

      process.env.REA_IDA_MCP_CONFIG = "C:\\private\\ida-config.json";
      process.env.REA_JADX_MCP_JAR = "C:\\private\\jadx.jar";
      const configured = setup({ platform: "linux" });
      expect(configured.manager.getIntegrationStatus().providerNotes).toEqual([]);
      expect(JSON.stringify(configured.manager.getIntegrationStatus())).not.toContain(
        "C:\\private",
      );
      expect(windows.clients).toHaveLength(0);
      expect(configured.clients).toHaveLength(0);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("starts lazily and gives the supervisor no redundant command arguments", async () => {
    const { manager, clients, transportParameters } = setup();
    expect(clients).toHaveLength(0);

    const page = await manager.listTools(owner("session-a"), { offset: 0, limit: 10 });

    expect(clients).toHaveLength(1);
    expect(page.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(transportParameters[0]).toMatchObject({
      command: "fake-rea-supervisor",
      args: [],
    });
    await manager.disposeAll();
  });

  it("reports status without starting, disables existing workers, and keeps enable/retry lazy", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "rea-settings-manager-"));
    testDataDirectories.push(userHome);
    const settingsStore = new ReaSettingsStore(userHome);
    const { manager, clients } = setup({ settingsStore });
    expect(manager.getIntegrationStatus()).toMatchObject({ enabled: true, status: "not_started" });
    expect(clients).toHaveLength(0);

    await manager.listTools(owner("settings-lifecycle"), { offset: 0, limit: 10 });
    await manager.listTools(owner("settings-lifecycle-second"), { offset: 0, limit: 10 });
    expect(manager.getIntegrationStatus()).toMatchObject({ status: "ready" });
    expect(clients).toHaveLength(2);
    const disabled = await manager.setEnabled(false);
    expect(disabled).toMatchObject({ enabled: false, status: "disabled" });
    expect(clients.every((client) => Boolean(client.close?.mock.calls.length))).toBe(true);
    await expect(
      manager.listTools(owner("settings-lifecycle"), { offset: 0, limit: 10 }),
    ).rejects.toThrow(/disabled/i);
    expect(clients).toHaveLength(2);

    expect(await manager.setEnabled(true)).toMatchObject({ enabled: true, status: "not_started" });
    expect(manager.retry()).toMatchObject({ enabled: true, status: "not_started" });
    expect(clients).toHaveLength(2);
    await manager.listTools(owner("settings-lifecycle"), { offset: 0, limit: 10 });
    expect(clients).toHaveLength(3);
    await manager.disposeAll();
  });

  it("moves readiness to a sanitized failure snapshot after worker disconnect", async () => {
    const { manager, transports } = setup();
    await manager.listTools(owner("status-disconnect"), { offset: 0, limit: 10 });
    expect(manager.getIntegrationStatus()).toMatchObject({ status: "ready" });
    transports[0]?.emitClose();
    await vi.waitFor(() => expect(manager.getIntegrationStatus().status).toBe("failed"));
    expect(manager.getIntegrationStatus()).toMatchObject({
      enabled: true,
      status: "failed",
      note: "REA connection was interrupted. Retry before the next approved call.",
    });
    await manager.disposeAll();
  });

  it("tracks ready workers through normal retirement and returns to not_started after the last closes", async () => {
    const { manager } = setup();
    const firstOwner = owner("status-retire-first");
    const secondOwner = owner("status-retire-second");
    await manager.listTools(firstOwner, { offset: 0, limit: 10 });
    await manager.listTools(secondOwner, { offset: 0, limit: 10 });

    await manager.disposeSession(firstOwner);
    expect(manager.getIntegrationStatus()).toMatchObject({ status: "ready" });
    await manager.disposeSession(secondOwner);
    const afterLastDispose = manager.getIntegrationStatus();
    expect(afterLastDispose).toMatchObject({ enabled: true, status: "not_started" });
    expect(afterLastDispose.note).toBeUndefined();
    await manager.disposeAll();
  });

  it("retains actionable failure status after uncertain cancellation and timeout until retry", async () => {
    const activeCall = deferred<unknown>();
    const { manager: cancelledManager, clients } = setup({ callTool: () => activeCall.promise });
    const cancelledOwner = owner("status-cancelled");
    await cancelledManager.listTools(cancelledOwner, { offset: 0, limit: 10 });
    const pendingCancellation = cancelledManager.callTool(cancelledOwner, "echo", {});
    void pendingCancellation.catch(() => {});
    await vi.waitFor(() => expect(clients[0]?.callTool).toHaveBeenCalledTimes(1));
    await cancelledManager.cancel(cancelledOwner);
    await expect(pendingCancellation).rejects.toThrow(/cancel/i);
    expect(cancelledManager.getIntegrationStatus()).toMatchObject({
      status: "failed",
      note: "REA connection was interrupted. Retry before the next approved call.",
    });
    expect(cancelledManager.retry()).toMatchObject({ status: "not_started" });
    activeCall.resolve({ content: [{ type: "text", text: "late" }] });
    await cancelledManager.disposeAll();

    vi.useFakeTimers();
    const operation = deferred<unknown>();
    const { manager } = setup({ operationTimeoutMs: 100, callTool: () => operation.promise });
    await manager.listTools(owner("status-timeout"), { offset: 0, limit: 10 });
    const pending = manager.callTool(owner("status-timeout"), "echo", {});
    void pending.catch(() => {});
    const rejected = expect(pending).rejects.toThrow(/timed out/i);
    await vi.waitFor(() =>
      expect(manager.getIntegrationStatus()).toMatchObject({ status: "ready" }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(manager.getIntegrationStatus()).toMatchObject({
      status: "failed",
      note: "REA connection was interrupted. Retry before the next approved call.",
    });
    expect(manager.retry()).toMatchObject({ status: "not_started" });
    operation.resolve({ content: [{ type: "text", text: "late" }] });
    await manager.disposeAll();
    vi.useRealTimers();
  });

  it("keeps disabled state and reports cleanup failure when worker retirement fails", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "rea-cleanup-disabled-"));
    testDataDirectories.push(userHome);
    const settingsStore = new ReaSettingsStore(userHome);
    const closeFailure = new Error("private path C:\\secret\\worker");
    const { manager } = setup({
      settingsStore,
      platform: "linux",
      transportPid: 7890,
      platformProcessOps: {
        killTree: async () => {
          throw closeFailure;
        },
      },
    });
    await manager.listTools(owner("disable-cleanup-failure"), { offset: 0, limit: 10 });

    const status = await manager.setEnabled(false);

    expect(status).toMatchObject({
      enabled: false,
      status: "failed",
      note: "REA worker cleanup could not be confirmed.",
    });
    expect(JSON.stringify(status)).not.toContain("secret");
    await manager.disposeAll().catch(() => {});
  });

  it("fails closed on malformed settings and exposes only a sanitized settings status", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "rea-settings-invalid-"));
    testDataDirectories.push(userHome);
    const settingsStore = new ReaSettingsStore(userHome);
    const { manager, clients } = setup({ settingsStore });
    mkdirSync(join(userHome, ".modus"), { recursive: true });
    writeFileSync(settingsStore.filePath, "{secret", "utf8");
    expect(manager.getIntegrationStatus()).toMatchObject({
      enabled: false,
      status: "failed",
      note: expect.not.stringContaining(userHome),
    });
    await expect(
      manager.listTools(owner("invalid-settings"), { offset: 0, limit: 10 }),
    ).rejects.toThrow(/settings/i);
    expect(clients).toHaveLength(0);
  });

  it("keeps per-session working directories and the shared npm cache under userData/rea", async () => {
    const { manager, transportParameters, userDataDirectory } = setup();
    await manager.listTools(owner("private-paths"), { offset: 0, limit: 10 });
    await manager.listTools(owner("private-paths-two"), { offset: 0, limit: 10 });

    const parameters = transportParameters.slice(0, 2);
    const workerDirectories = parameters.map((item) => item.cwd as string);
    expect(workerDirectories.map(dirname)).toEqual([
      join(userDataDirectory, "rea", "workers"),
      join(userDataDirectory, "rea", "workers"),
    ]);
    expect(new Set(workerDirectories).size).toBe(2);
    expect(parameters.map((item) => (item.env as Record<string, string>).npm_config_cache)).toEqual(
      [join(userDataDirectory, "rea", "npm-cache"), join(userDataDirectory, "rea", "npm-cache")],
    );
    if (process.platform !== "win32") {
      for (const directory of [
        join(userDataDirectory, "rea"),
        join(userDataDirectory, "rea", "workers"),
        join(userDataDirectory, "rea", "npm-cache"),
      ]) {
        expect(statSync(directory).mode & 0o777).toBe(0o700);
      }
    }
    await manager.disposeAll();
  });

  it("sweeps stale worker directories once without touching non-worker siblings", async () => {
    const { manager, userDataDirectory, transportParameters } = setup();
    const workersDirectory = join(userDataDirectory, "rea", "workers");
    const staleDirectory = join(workersDirectory, "worker-stale-leftover");
    mkdirSync(staleDirectory, { recursive: true });
    writeFileSync(join(staleDirectory, "leftover.txt"), "stale");
    const nonWorkerSibling = join(workersDirectory, "scratch");
    mkdirSync(nonWorkerSibling, { recursive: true });

    await manager.listTools(owner("stale-sweep"), { offset: 0, limit: 10 });
    const firstWorkerDirectory = transportParameters[0]?.cwd as string;
    expect(existsSync(staleDirectory)).toBe(false);
    expect(existsSync(nonWorkerSibling)).toBe(true);

    await manager.listTools(owner("stale-sweep-second"), { offset: 0, limit: 10 });
    expect(existsSync(firstWorkerDirectory)).toBe(true);
    expect(transportParameters[1]?.cwd).not.toBe(firstWorkerDirectory);
    await manager.disposeAll();
  });

  it("still starts a worker when stale-directory removal fails", async () => {
    const { manager, userDataDirectory } = setup({
      removeWorkerDirectory: () => {
        throw new Error("directory is locked");
      },
    });
    const staleDirectory = join(userDataDirectory, "rea", "workers", "worker-locked");
    mkdirSync(staleDirectory, { recursive: true });

    await expect(
      manager.listTools(owner("stale-locked"), { offset: 0, limit: 10 }),
    ).resolves.toMatchObject({ tools: [{ name: "echo" }] });
    expect(existsSync(staleDirectory)).toBe(true);
    await manager.disposeAll();
  });

  it("reports needs_node and starts nothing when prerequisites are missing", async () => {
    const { manager, clients } = setup({
      checkPrerequisites: async () => ({
        ok: false,
        status: "needs_node",
        note: "REA needs Node.js ^22.19.0 || ^24.11.0 || >=26.0.0 and npm/npx on PATH.",
      }),
    });
    await expect(manager.listTools(owner("no-node"), { offset: 0, limit: 10 })).rejects.toThrow(
      /Node\.js/,
    );
    expect(clients).toHaveLength(0);
    expect(manager.getIntegrationStatus()).toMatchObject({
      enabled: true,
      status: "needs_node",
      note: expect.stringContaining("^22.19.0"),
    });
    await manager.disposeAll();
  });

  it("classifies a cold-cache offline failure from captured stderr as a network error", async () => {
    let feedStderr: ((text: string) => void) | undefined;
    const harness = setup({
      transportStderr: true,
      connect: async () => {
        feedStderr?.("npm ERR! code ENOTFOUND registry.npmjs.org fetch failed");
        throw new Error("MCP error -32000: Connection closed");
      },
    });
    feedStderr = (text) => harness.emitStderr(0, text);

    await expect(
      harness.manager.listTools(owner("offline-cache"), { offset: 0, limit: 10 }),
    ).rejects.toThrow();
    expect(harness.manager.getIntegrationStatus()).toMatchObject({
      enabled: true,
      status: "network_error",
    });
    await harness.manager.disposeAll();
  });

  it("never publishes captured stderr in a status note", async () => {
    let feedStderr: ((text: string) => void) | undefined;
    const harness = setup({
      transportStderr: true,
      connect: async () => {
        feedStderr?.("npm ERR! path D:/SensitiveClient/Modus/rea/workers/worker-abc/_logs/x.log");
        throw new Error("MCP error -32000: Connection closed");
      },
    });
    feedStderr = (text) => harness.emitStderr(0, text);

    await expect(
      harness.manager.listTools(owner("stderr-note"), { offset: 0, limit: 10 }),
    ).rejects.toThrow();
    const status = harness.manager.getIntegrationStatus();
    expect(status.status).toBe("failed");
    expect(status.note).toBe(
      "REA could not start. Retry after checking Node.js, npm, and network availability.",
    );
    expect(JSON.stringify(status)).not.toContain("SensitiveClient");
    await harness.manager.disposeAll();
  });

  it("classifies an offline failure even behind a long stderr prefix", async () => {
    let feedStderr: ((text: string) => void) | undefined;
    const harness = setup({
      transportStderr: true,
      connect: async () => {
        feedStderr?.(`${"banner ".repeat(80)}npm ERR! code ENOTFOUND registry.npmjs.org`);
        throw new Error("MCP error -32000: Connection closed");
      },
    });
    feedStderr = (text) => harness.emitStderr(0, text);

    await expect(
      harness.manager.listTools(owner("offline-long-prefix"), { offset: 0, limit: 10 }),
    ).rejects.toThrow();
    expect(harness.manager.getIntegrationStatus().status).toBe("network_error");
    await harness.manager.disposeAll();
  });

  it("does not treat a node runtime trace as a missing Node install", async () => {
    let feedStderr: ((text: string) => void) | undefined;
    const harness = setup({
      transportStderr: true,
      connect: async () => {
        feedStderr?.("Error at node:internal/process/task_queues:104:5 processTicksAndRejections");
        throw new Error("MCP error -32000: Connection closed");
      },
    });
    feedStderr = (text) => harness.emitStderr(0, text);

    await expect(
      harness.manager.listTools(owner("node-trace"), { offset: 0, limit: 10 }),
    ).rejects.toThrow();
    expect(harness.manager.getIntegrationStatus().status).toBe("failed");
    await harness.manager.disposeAll();
  });

  it("classifies an offline failure when the transport closes before connect rejects", async () => {
    let feedStderr: ((text: string) => void) | undefined;
    let closeTransport: (() => void) | undefined;
    const harness = setup({
      transportStderr: true,
      connect: () => {
        feedStderr?.("npm ERR! code ENOTFOUND registry.npmjs.org fetch failed");
        closeTransport?.();
        throw new Error("MCP error -32000: Connection closed");
      },
    });
    feedStderr = (text) => harness.emitStderr(0, text);
    closeTransport = () => harness.transports[0]?.emitClose();

    await expect(
      harness.manager.listTools(owner("close-before-reject"), { offset: 0, limit: 10 }),
    ).rejects.toThrow();
    expect(harness.manager.getIntegrationStatus().status).toBe("network_error");
    await harness.manager.disposeAll();
  });

  it("does not read an _npx stack path as a missing Node install", async () => {
    let feedStderr: ((text: string) => void) | undefined;
    const harness = setup({
      transportStderr: true,
      connect: async () => {
        feedStderr?.(
          "TypeError: invalid result at file:///home/alice/.npm/_npx/abcdef/node_modules/rea-agents/dist/index.js:1:1",
        );
        throw new Error("MCP error -32000: Connection closed");
      },
    });
    feedStderr = (text) => harness.emitStderr(0, text);

    await expect(
      harness.manager.listTools(owner("npx-stack-path"), { offset: 0, limit: 10 }),
    ).rejects.toThrow();
    expect(harness.manager.getIntegrationStatus().status).toBe("failed");
    await harness.manager.disposeAll();
  });

  it("does not read an unrelated file ENOENT as a missing Node install", async () => {
    let feedStderr: ((text: string) => void) | undefined;
    const harness = setup({
      transportStderr: true,
      connect: async () => {
        feedStderr?.("Error: ENOENT: no such file or directory, open /opt/rea/provider.json");
        throw new Error("MCP error -32000: Connection closed");
      },
    });
    feedStderr = (text) => harness.emitStderr(0, text);

    await expect(
      harness.manager.listTools(owner("unrelated-enoent"), { offset: 0, limit: 10 }),
    ).rejects.toThrow();
    expect(harness.manager.getIntegrationStatus().status).toBe("failed");
    await harness.manager.disposeAll();
  });

  it("classifies a missing npx command as needs_node", async () => {
    let feedStderr: ((text: string) => void) | undefined;
    const harness = setup({
      transportStderr: true,
      connect: async () => {
        feedStderr?.("'npx' is not recognized as an internal or external command");
        throw new Error("MCP error -32000: Connection closed");
      },
    });
    feedStderr = (text) => harness.emitStderr(0, text);

    await expect(
      harness.manager.listTools(owner("missing-npx"), { offset: 0, limit: 10 }),
    ).rejects.toThrow();
    expect(harness.manager.getIntegrationStatus().status).toBe("needs_node");
    await harness.manager.disposeAll();
  });

  it("does not launch a worker when the session is disposed during the prerequisite probe", async () => {
    const probe = deferred<ReaPrerequisiteResult>();
    const checkPrerequisites = vi.fn(() => probe.promise);
    const { manager, clients } = setup({ checkPrerequisites });
    const pending = manager.listTools(owner("disposed-during-probe"), { offset: 0, limit: 10 });
    void pending.catch(() => {});

    await vi.waitFor(() => expect(checkPrerequisites).toHaveBeenCalledTimes(1));
    await manager.disposeSession(owner("disposed-during-probe"));
    probe.resolve({ ok: true });

    await expect(pending).rejects.toThrow(/stale|disposed/i);
    expect(clients).toHaveLength(0);
    expect(manager.getIntegrationStatus().status).not.toBe("failed");
    await manager.disposeAll();
  });

  it("reports starting while the initial catalog request is pending", async () => {
    const catalogPage = deferred<{ tools: Array<{ name: string }> }>();
    const { manager, clients } = setup({ listTools: () => catalogPage.promise as never });
    const pending = manager.listTools(owner("catalog-pending"), { offset: 0, limit: 10 });

    await vi.waitFor(() => expect(clients[0]?.listTools).toHaveBeenCalledTimes(1));
    expect(manager.getIntegrationStatus().status).toBe("starting");

    catalogPage.resolve({ tools: [{ name: "echo" }] });
    await expect(pending).resolves.toMatchObject({ tools: [{ name: "echo" }] });
    expect(manager.getIntegrationStatus().status).toBe("ready");
    await manager.disposeAll();
  });

  it("reports starting when catalog discovery retries after a failure", async () => {
    const attempts: Array<{
      resolve: (value: { tools: Array<{ name: string }> }) => void;
      reject: (error: unknown) => void;
    }> = [];
    const { manager } = setup({
      listTools: () => {
        const attempt = deferred<{ tools: Array<{ name: string }> }>();
        attempts.push(attempt);
        return attempt.promise as never;
      },
    });
    const first = manager.listTools(owner("catalog-retry"), { offset: 0, limit: 10 });
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    attempts[0]?.reject(new Error("catalog unavailable"));
    await expect(first).rejects.toThrow(/catalog unavailable/);
    expect(manager.getIntegrationStatus().status).toBe("failed");

    manager.retry();
    const second = manager.listTools(owner("catalog-retry"), { offset: 0, limit: 10 });
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    expect(manager.getIntegrationStatus().status).toBe("starting");

    attempts[1]?.resolve({ tools: [{ name: "echo" }] });
    await expect(second).resolves.toMatchObject({ tools: [{ name: "echo" }] });
    expect(manager.getIntegrationStatus().status).toBe("ready");
    await manager.disposeAll();
  });

  it("keeps reporting starting for overlapping callers on one acquisition", async () => {
    const catalogPage = deferred<{ tools: Array<{ name: string }> }>();
    const { manager, clients } = setup({ listTools: () => catalogPage.promise as never });
    const target = owner("catalog-overlap");
    const first = manager.listTools(target, { offset: 0, limit: 10 });
    await vi.waitFor(() => expect(clients[0]?.listTools).toHaveBeenCalledTimes(1));
    const second = manager.listTools(target, { offset: 0, limit: 10 });

    await vi.waitFor(() => expect(manager.getIntegrationStatus().status).toBe("starting"));
    expect(clients[0]?.listTools).toHaveBeenCalledTimes(1);

    catalogPage.resolve({ tools: [{ name: "echo" }] });
    await expect(first).resolves.toMatchObject({ tools: [{ name: "echo" }] });
    await expect(second).resolves.toMatchObject({ tools: [{ name: "echo" }] });
    expect(manager.getIntegrationStatus().status).toBe("ready");
    await manager.disposeAll();
  });

  it("suppresses the readiness failure when a worker is disposed mid-catalog", async () => {
    const catalogPage = deferred<{ tools: Array<{ name: string }> }>();
    const { manager, clients } = setup({ listTools: () => catalogPage.promise as never });
    const pending = manager.listTools(owner("catalog-dispose"), { offset: 0, limit: 10 });
    void pending.catch(() => {});

    await vi.waitFor(() => expect(clients[0]?.listTools).toHaveBeenCalledTimes(1));
    await manager.disposeSession(owner("catalog-dispose"));
    catalogPage.reject(new Error("catalog aborted"));
    await expect(pending).rejects.toThrow();
    expect(manager.getIntegrationStatus().status).not.toBe("failed");
    await manager.disposeAll();
  });

  it("forwards only the documented OS and REA provider environment allowlist", async () => {
    const providerEnvironment = {
      GHIDRA_INSTALL_DIR: "C:\\configured\\ghidra",
      JAVA_HOME: "C:\\configured\\java",
      REA_ANALYSIS_PROVIDER: "ghidra",
      REA_IDA_MCP_CONFIG: "C:\\configured\\ida.json",
      REA_JADX_MCP_JAR: "C:\\configured\\jadx.jar",
    };
    const previousProviderValues = Object.fromEntries(
      Object.keys(providerEnvironment).map((key) => [key, process.env[key]]),
    );
    const previousSecret = process.env.REA_MANAGER_TEST_SECRET;
    Object.assign(process.env, providerEnvironment);
    process.env.REA_MANAGER_TEST_SECRET = "must-not-leak";
    const { manager, transportParameters } = setup();
    try {
      await manager.listTools(owner("allowlisted-env"), { offset: 0, limit: 10 });
      const env = transportParameters[0]?.env as Record<string, string>;
      expect(env).toMatchObject(providerEnvironment);
      expect(env.REA_MANAGER_TEST_SECRET).toBeUndefined();
      const allowedVariables = new Set([
        "PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "SystemRoot",
        "WINDIR",
        "PATHEXT",
        "ComSpec",
        "npm_config_cache",
        ...Object.keys(providerEnvironment),
      ]);
      expect(Object.keys(env).every((key) => allowedVariables.has(key))).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previousProviderValues)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (previousSecret === undefined) delete process.env.REA_MANAGER_TEST_SECRET;
      else process.env.REA_MANAGER_TEST_SECRET = previousSecret;
      await manager.disposeAll();
    }
  });

  it("shares one in-flight startup for concurrent requests", async () => {
    const start = deferred<void>();
    const { manager, clients } = setup({ connect: () => start.promise });
    const first = manager.listTools(owner("session-a"), { offset: 0, limit: 10 });
    const second = manager.listTools(owner("session-a"), { offset: 0, limit: 10 });
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    start.resolve();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(clients[0]?.connect).toHaveBeenCalledTimes(1);
    expect(clients[0]?.listTools).toHaveBeenCalledTimes(1);
    await manager.disposeAll();
  });

  it("allows a fresh approved request after a worker startup failure", async () => {
    let attempts = 0;
    const { manager, clients } = setup({
      connect: async () => {
        attempts++;
        if (attempts === 1) throw new Error("cold package cache unavailable");
      },
    });
    await expect(
      manager.listTools(owner("retry-session"), { offset: 0, limit: 10 }),
    ).rejects.toThrow("cold package cache unavailable");

    await expect(
      manager.listTools(owner("retry-session"), { offset: 0, limit: 10 }),
    ).resolves.toMatchObject({ tools: [{ name: "echo" }] });
    expect(clients).toHaveLength(2);
    await manager.disposeAll();
  });

  it("isolates workers for different sessions in the same workspace", async () => {
    const { manager, clients } = setup();
    await Promise.all([
      manager.listTools(owner("session-a"), { offset: 0, limit: 10 }),
      manager.listTools(owner("session-b"), { offset: 0, limit: 10 }),
    ]);
    expect(clients).toHaveLength(2);
    await manager.disposeAll();
  });

  it("rejects an old generation after the session advances", async () => {
    const { manager } = setup();
    await manager.listTools(owner("session-a", "g1"), { offset: 0, limit: 10 });
    await manager.disposeSession(owner("session-a", "g1"));
    await manager.listTools(owner("session-a", "g2"), { offset: 0, limit: 10 });

    await expect(
      manager.listTools(owner("session-a", "g1"), { offset: 0, limit: 10 }),
    ).rejects.toThrow(/stale/i);
    await manager.disposeAll();
  });

  it("filters catalog queries and caps pages at ten entries", async () => {
    const tools = Array.from({ length: 15 }, (_, index) => ({
      name: `inspect_${index}`,
      description: index % 2 === 0 ? "inspect target" : "other operation",
      inputSchema: { type: "object" },
    }));
    const { manager } = setup({ listTools: async () => ({ tools }) });

    const page = await manager.listTools(owner("session-a"), {
      query: "inspect",
      offset: 2,
      limit: 50,
    });

    expect(page).toMatchObject({ offset: 2, limit: MAX_REA_CATALOG_PAGE_SIZE, total: 15 });
    expect(page.tools).toHaveLength(10);
    expect(page.tools[0]).toMatchObject({ name: "inspect_2", inputSchema: { type: "object" } });
    await manager.disposeAll();
  });

  it("rejects catalogs larger than 512 tools", async () => {
    const tools = Array.from({ length: 513 }, (_, index) => ({ name: `tool-${index}` }));
    const { manager } = setup({ listTools: async () => ({ tools }) });

    await expect(
      manager.listTools(owner("catalog-size"), { offset: 0, limit: 10 }),
    ).rejects.toThrow(/catalog.*512/i);
    await manager.disposeAll();
  });

  it("rejects catalogs that require more than 64 cursor pages", async () => {
    let pageCount = 0;
    const { manager } = setup({
      listTools: async () => {
        pageCount++;
        return {
          tools: [],
          ...(pageCount < 70 ? { nextCursor: `cursor-${pageCount}` } : {}),
        };
      },
    });

    await expect(
      manager.listTools(owner("catalog-cursors"), { offset: 0, limit: 10 }),
    ).rejects.toThrow(/catalog.*64.*page/i);
    expect(pageCount).toBeLessThanOrEqual(64);
    await manager.disposeAll();
  });

  it("rejects catalog descriptors whose serialized schemas exceed the byte bound", async () => {
    const { manager } = setup({
      listTools: async () => ({
        tools: [
          { name: "large-schema", inputSchema: { description: "x".repeat(4 * 1024 * 1024 + 1) } },
        ],
      }),
    });

    await expect(
      manager.listTools(owner("catalog-bytes"), { offset: 0, limit: 10 }),
    ).rejects.toThrow(/catalog.*byte/i);
    await manager.disposeAll();
  });

  it("bounds the total time spent discovering all catalog pages", async () => {
    vi.useFakeTimers();
    const pendingPage = deferred<{ tools: Array<{ name: string }> }>();
    const { manager, clients } = setup({
      listTools: () => pendingPage.promise,
      catalogTimeoutMs: 100,
    });
    let settled = false;
    const pending = manager.listTools(owner("catalog-timeout"), { offset: 0, limit: 10 });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(clients[0]?.listTools).toHaveBeenCalledTimes(1));
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
      expect(manager.getIntegrationStatus().status).toBe("failed");
    } finally {
      pendingPage.resolve({ tools: [] });
      await manager.disposeAll();
    }
  });

  it("rejects operations absent from the worker catalog", async () => {
    const { manager, clients } = setup();
    await expect(manager.callTool(owner("session-a"), "unknown", {})).rejects.toThrow(/unknown/i);
    expect(clients[0]?.callTool).not.toHaveBeenCalled();
    await manager.disposeAll();
  });

  it("serializes calls on each worker", async () => {
    const firstResult = deferred<unknown>();
    let active = 0;
    let maxActive = 0;
    const { manager } = setup({
      listTools: async () => ({ tools: [{ name: "echo" }, { name: "next" }] }),
      callTool: async (name) => {
        active++;
        maxActive = Math.max(active, maxActive);
        if (name === "echo") await firstResult.promise;
        active--;
        return { content: [{ type: "text", text: name }] };
      },
    });
    const first = manager.callTool(owner("session-a"), "echo", {});
    await vi.waitFor(() => expect(active).toBe(1));
    const second = manager.callTool(owner("session-a"), "next", {});
    await Promise.resolve();
    expect(maxActive).toBe(1);
    firstResult.resolve({});
    await Promise.all([first, second]);
    await manager.disposeAll();
  });

  it("enforces worker and per-worker queued-call bounds without eviction", async () => {
    const gate = deferred<unknown>();
    const { manager, clients } = setup({ callTool: () => gate.promise });
    const owners = Array.from({ length: MAX_REA_WORKERS }, (_, index) => owner(`session-${index}`));
    const primaryOwner = owner("session-0");
    await Promise.all(owners.map((item) => manager.listTools(item, { offset: 0, limit: 10 })));
    await expect(
      manager.listTools(owner("over-capacity"), { offset: 0, limit: 10 }),
    ).rejects.toThrow(/busy/i);

    const active = manager.callTool(primaryOwner, "echo", {});
    await vi.waitFor(() => expect(clients[0]?.callTool).toHaveBeenCalledTimes(1));
    const queued = Array.from({ length: REA_QUEUED_CALLS_PER_WORKER }, () =>
      manager.callTool(primaryOwner, "echo", {}),
    );
    await expect(manager.callTool(primaryOwner, "echo", {})).rejects.toThrow(/busy/i);
    gate.resolve({ content: [{ type: "text", text: "ok" }] });
    await Promise.all([active, ...queued]);
    expect(clients).toHaveLength(MAX_REA_WORKERS);
    await manager.disposeAll();
  });

  it("applies the specified startup and operation timeouts", () => {
    expect(REA_STARTUP_TIMEOUT_MS).toBe(180_000);
    expect(REA_OPERATION_TIMEOUT_MS).toBe(600_000);
  });

  it("bounds startup and closes a connection that misses the startup deadline", async () => {
    vi.useFakeTimers();
    const start = deferred<void>();
    const { manager, clients, transports } = setup({
      connect: () => start.promise,
      startupTimeoutMs: 100,
    });
    const pending = manager.listTools(owner("startup-timeout"), { offset: 0, limit: 10 });
    const expectation = expect(pending).rejects.toThrow(/startup timed out/i);
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(100);
    await expectation;
    expect(clients[0]?.close).toHaveBeenCalled();
    expect(transports[0]?.close).toHaveBeenCalled();
    start.resolve();
    await manager.disposeAll();
  });

  it("bounds oversized results and retires timed-out calls without replay", async () => {
    vi.useFakeTimers();
    const result = deferred<unknown>();
    const { manager, clients } = setup({
      callTool: () => result.promise,
    });
    const timed = manager.callTool(owner("timeout-session"), "echo", {});
    const timedExpectation = expect(timed).rejects.toThrow(/timed out/i);
    await vi.waitFor(() => expect(clients[0]?.callTool).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(REA_OPERATION_TIMEOUT_MS);
    await timedExpectation;
    expect(clients[0]?.callTool).toHaveBeenCalledTimes(1);
    result.resolve({ content: [{ type: "text", text: "late" }] });
    await Promise.resolve();
    expect(clients[0]?.callTool).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    const oversized = "x".repeat(MAX_REA_RESULT_BYTES + 1);
    const bounded = setup({
      callTool: async () => ({ content: [{ type: "text", text: oversized }] }),
    });
    const response = await bounded.manager.callTool(owner("large-session"), "echo", {});
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(MAX_REA_RESULT_BYTES);
    expect(JSON.stringify(response)).toContain("truncated");
    await bounded.manager.disposeAll();
    await manager.disposeAll();
  });

  it("preserves a bounded text prefix and small evidence metadata when truncating results", async () => {
    const { manager } = setup({
      callTool: async () => ({
        content: [{ type: "text", text: `evidence-prefix:${"x".repeat(MAX_REA_RESULT_BYTES)}` }],
        _meta: { evidence_id: "ev_test_123", source: "rea" },
        structuredContent: { summary: "evidence summary" },
      }),
    });

    const response = await manager.callTool(owner("evidence-result"), "echo", {});

    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(MAX_REA_RESULT_BYTES);
    expect(JSON.stringify(response.content)).toContain("evidence-prefix");
    expect(JSON.stringify(response.content)).toContain("REA result truncated");
    expect(response._meta).toMatchObject({ evidence_id: "ev_test_123", source: "rea" });
    expect(response.structuredContent).toEqual({ summary: "evidence summary" });
    await manager.disposeAll();
  });

  it("closes a worker whose startup completes after disposal", async () => {
    const start = deferred<void>();
    const { manager, clients, transports } = setup({ connect: () => start.promise });
    const pending = manager.listTools(owner("late-session"), { offset: 0, limit: 10 });
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    await manager.disposeSession(owner("late-session"));
    await expect(pending).rejects.toThrow(/stale|disposed/i);
    start.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(clients[0]?.close).toHaveBeenCalled();
    expect(transports[0]?.close).toHaveBeenCalled();
    await manager.disposeAll();
  });

  it("does not replay an in-flight operation after session disposal", async () => {
    const result = deferred<unknown>();
    const { manager, clients } = setup({ callTool: () => result.promise });
    const pending = manager.callTool(owner("cancel-session"), "echo", {});
    await vi.waitFor(() => expect(clients[0]?.callTool).toHaveBeenCalledTimes(1));
    await manager.disposeSession(owner("cancel-session"));
    await expect(pending).rejects.toThrow(/stale|disposed/i);
    expect(clients[0]?.callTool).toHaveBeenCalledTimes(1);
    result.resolve({ content: [{ type: "text", text: "late result" }] });
    await Promise.resolve();
    await manager.disposeAll();
  });

  it("retires a disconnected worker and kills only its POSIX supervisor process group", async () => {
    const killTree = vi.fn();
    const { manager, clients, transports } = setup({
      platform: "linux",
      transportPid: 7654,
      platformProcessOps: { killTree },
    });
    await manager.listTools(owner("disconnect-after-catalog"), { offset: 0, limit: 10 });
    const oldCloseHandler = transports[0]?.onclose;
    transports[0]?.emitClose();
    await vi.waitFor(() => expect(killTree).toHaveBeenCalledWith(7654));
    await vi.waitFor(() => expect(clients[0]?.close).toHaveBeenCalled());

    await expect(
      manager.listTools(owner("disconnect-after-catalog"), { offset: 0, limit: 10 }),
    ).resolves.toMatchObject({ tools: [{ name: "echo" }] });
    expect(clients).toHaveLength(2);
    oldCloseHandler?.();
    await Promise.resolve();
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(clients[1]?.close).not.toHaveBeenCalled();
    await manager.disposeAll();
  });

  it("uses confirmed TERM-to-KILL process-group cleanup before releasing capacity", async () => {
    vi.useFakeTimers();
    const pid = 43_210;
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (signal === 0) {
        if (groupAlive && (target === pid || target === -pid)) return true;
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      if (target === -pid && signal === "SIGTERM") return true;
      if (target === -pid && signal === "SIGKILL") {
        setTimeout(() => {
          groupAlive = false;
        }, 100);
        return true;
      }
      throw new Error(`unexpected process signal ${String(signal)} for ${target}`);
    });
    const { manager, transports } = setup({ platform: "linux", transportPid: pid });
    await manager.listTools(owner("platform-cleanup"), { offset: 0, limit: 10 });

    try {
      transports[0]?.emitClose();
      await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-pid, "SIGTERM"));
      await expect(
        manager.listTools(owner("platform-cleanup"), { offset: 0, limit: 10 }),
      ).rejects.toThrow(/closing/i);
      await vi.advanceTimersByTimeAsync(300);
      expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
      expect(groupAlive).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() =>
        expect(
          manager.listTools(owner("platform-cleanup"), { offset: 0, limit: 10 }),
        ).resolves.toMatchObject({ tools: [{ name: "echo" }] }),
      );
    } finally {
      await manager.disposeAll();
    }
  });

  it("settles timed-out active and queued callers when cleanup fails, quarantines capacity, and retries cleanup explicitly", async () => {
    vi.useFakeTimers();
    const operation = deferred<unknown>();
    let cleanupAttempts = 0;
    const killTree = vi.fn(async () => {
      cleanupAttempts++;
      if (cleanupAttempts === 1) throw new Error("sensitive process details");
    });
    const { manager, clients, calls } = setup({
      platform: "linux",
      operationTimeoutMs: 100,
      platformProcessOps: { killTree },
      callTool: () => operation.promise,
    });
    const primaryOwner = owner("cleanup-failure");
    await manager.listTools(primaryOwner, { offset: 0, limit: 10 });
    await Promise.all(
      ["cleanup-peer-1", "cleanup-peer-2", "cleanup-peer-3"].map((sessionId) =>
        manager.listTools(owner(sessionId), { offset: 0, limit: 10 }),
      ),
    );

    const active = manager.callTool(primaryOwner, "echo", {});
    let activeSettled = false;
    const activeOutcome = active.then(
      (value) => {
        activeSettled = true;
        return { value };
      },
      (error: unknown) => {
        activeSettled = true;
        return { error };
      },
    );
    await vi.waitFor(() => expect(clients[0]?.callTool).toHaveBeenCalledTimes(1));
    const queued = manager.callTool(primaryOwner, "echo", {});
    void queued.catch(() => {});
    const queuedOutcome = queued.then(
      () => "resolved",
      (error: unknown) => error,
    );
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(activeSettled).toBe(true));
      const [activeResult, queuedResult] = await Promise.all([activeOutcome, queuedOutcome]);
      expect(activeResult).toHaveProperty("error");
      expect(String((activeResult as { error: unknown }).error)).toMatch(
        /cleanup failed.*quarantined/i,
      );
      expect(String(queuedResult)).toMatch(/stale|disposed/i);
      expect(String((activeResult as { error: unknown }).error)).not.toContain(
        "sensitive process details",
      );
      expect(calls).toHaveLength(1);
      expect(killTree).toHaveBeenCalledTimes(1);
      await expect(
        manager.listTools(owner("cleanup-capacity-probe"), { offset: 0, limit: 10 }),
      ).rejects.toThrow(/busy/i);

      await manager.disposeSession(primaryOwner);
      expect(killTree).toHaveBeenCalledTimes(2);
      await expect(
        manager.listTools(owner("cleanup-capacity-probe"), { offset: 0, limit: 10 }),
      ).resolves.toMatchObject({ tools: [{ name: "echo" }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      operation.resolve({ content: [{ type: "text", text: "late response" }] });
      await manager.disposeAll().catch(() => {});
    }
  });

  it("rejects active and queued calls after disconnect without replay", async () => {
    const operation = deferred<unknown>();
    const killTree = vi.fn();
    const { manager, clients, transports, calls } = setup({
      platform: "linux",
      platformProcessOps: { killTree },
      callTool: () => operation.promise,
    });
    const active = manager.callTool(owner("disconnect-calls"), "echo", {});
    await vi.waitFor(() => expect(clients[0]?.callTool).toHaveBeenCalledTimes(1));
    const queued = manager.callTool(owner("disconnect-calls"), "echo", {});
    void active.catch(() => {});
    void queued.catch(() => {});

    transports[0]?.emitClose();
    await vi.waitFor(() => expect(clients[0]?.close).toHaveBeenCalled());
    await expect(active).rejects.toThrow(/disposed|stale/i);
    await expect(queued).rejects.toThrow(/disposed|stale/i);
    expect(calls).toHaveLength(1);
    operation.resolve({ content: [{ type: "text", text: "late" }] });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    await manager.disposeAll();
  });

  it("cancels active and queued calls without execution or replay and permits same-generation recovery", async () => {
    const operation = deferred<unknown>();
    let operationCount = 0;
    const { manager, clients, calls } = setup({
      callTool: () =>
        operationCount++ === 0
          ? operation.promise
          : Promise.resolve({ content: [{ type: "text", text: "echo" }] }),
    });
    const sameOwner = owner("cancel-call-owner");
    const active = manager.callTool(sameOwner, "echo", {});
    await vi.waitFor(() => expect(clients[0]?.callTool).toHaveBeenCalledTimes(1));
    const queued = manager.callTool(sameOwner, "echo", {});
    void active.catch(() => {});
    void queued.catch(() => {});

    await manager.cancel(sameOwner);
    await expect(active).rejects.toThrow(/cancel/i);
    await expect(queued).rejects.toThrow(/cancel|stale|disposed/i);
    expect(calls).toHaveLength(1);
    operation.resolve({ content: [{ type: "text", text: "late" }] });
    await Promise.resolve();

    await expect(manager.callTool(sameOwner, "echo", {})).resolves.toMatchObject({
      content: [{ text: "echo" }],
    });
    expect(clients).toHaveLength(2);
    expect(calls).toHaveLength(2);
    await manager.disposeAll();
  });

  it("holds worker capacity until disconnect cleanup finishes, then allows same-generation recovery", async () => {
    let closeBegan = false;
    const closeGate = deferred<void>();
    const closeFinished = deferred<void>();
    const { manager, clients, transports } = setup({
      transportClose: async (index) => {
        if (index === 0) {
          closeBegan = true;
          await closeGate.promise;
          closeFinished.resolve();
        }
      },
    });
    const owners = Array.from({ length: MAX_REA_WORKERS }, (_, index) => owner(`closing-${index}`));
    const primaryOwner = owner("closing-0");
    await Promise.all(owners.map((item) => manager.listTools(item, { offset: 0, limit: 10 })));
    try {
      transports[0]?.emitClose();
      await vi.waitFor(() => expect(closeBegan).toBe(true));

      await expect(
        manager.listTools(owner("during-close"), { offset: 0, limit: 10 }),
      ).rejects.toThrow(/busy/i);
      closeGate.resolve();
      await closeFinished.promise;
      await vi.waitFor(() =>
        expect(manager.listTools(primaryOwner, { offset: 0, limit: 10 })).resolves.toMatchObject({
          tools: [{ name: "echo" }],
        }),
      );
      expect(clients).toHaveLength(MAX_REA_WORKERS + 1);
    } finally {
      closeGate.resolve();
      await manager.disposeAll();
    }
  });

  it("disposeAll closes every worker", async () => {
    const { manager, clients, transports } = setup();
    await Promise.all(
      ["session-a", "session-b"].map((sessionId) =>
        manager.listTools(owner(sessionId), { offset: 0, limit: 10 }),
      ),
    );

    await manager.disposeAll();

    expect(clients.every((client) => Boolean(client.close?.mock.calls.length))).toBe(true);
    expect(transports.every((transport) => transport.close.mock.calls.length > 0)).toBe(true);
  });
});
