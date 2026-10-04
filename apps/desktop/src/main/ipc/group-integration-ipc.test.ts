import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupRuntimeEvent } from "../../shared/contracts";
import type {
  GroupIntegrationPreview,
  GroupIntegrationRecord,
} from "../../shared/group-work-state";
import { IPC_CHANNELS } from "./channels";
import type { TrustedSenderEvent } from "./trusted-sender";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/modus-group-integration-ipc-test" },
  BrowserWindow: { getAllWindows: () => [] },
}));

type Handler = (event: TrustedSenderEvent, input?: unknown) => unknown;

const preview: GroupIntegrationPreview = {
  id: "preview-1",
  groupId: "g-1",
  taskId: "t-1",
  taskVersion: 2,
  sourceBranch: "group/g-1/worker",
  sourceSha: "a".repeat(40),
  sourceFingerprint: "b".repeat(40),
  targetBranch: "main",
  targetSha: "c".repeat(40),
  targetFingerprint: "d".repeat(40),
  commits: [{ sha: "a".repeat(40), subject: "Finish parser" }],
  omittedCommitCount: 0,
  changedFiles: [{ path: "src/parser.ts", status: "modified" }],
  omittedChangedFileCount: 0,
  diffSummary: "diff --git a/src/parser.ts b/src/parser.ts",
  createdAt: "2026-10-03T00:00:00.000Z",
  status: "ready",
};

const record: GroupIntegrationRecord = {
  id: "integration-1",
  groupId: "g-1",
  taskId: "t-1",
  previewId: "preview-1",
  taskVersion: 2,
  sourceBranch: "group/g-1/worker",
  sourceSha: "a".repeat(40),
  targetBranch: "main",
  targetSha: "c".repeat(40),
  status: "ready",
  version: 3,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
};

function setup() {
  const listeners: Array<(value: GroupIntegrationRecord) => void> = [];
  const emitRecord = (value: GroupIntegrationRecord) => {
    for (const listener of listeners) listener(value);
  };
  const applied = { ...record, status: "applied" as const, version: 4 };
  const aborted = { ...applied, status: "aborted" as const, version: 5 };
  const service = {
    onIntegrationChanged: vi.fn((listener: (value: GroupIntegrationRecord) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
    previewGroupTaskIntegration: vi.fn(async () => {
      emitRecord(record);
      return preview;
    }),
    applyGroupTaskIntegration: vi.fn(async () => {
      emitRecord(applied);
      return applied;
    }),
    abortGroupTaskIntegration: vi.fn(async () => {
      emitRecord(aborted);
      return aborted;
    }),
    getIntegrationState: vi.fn(() => ({ record, preview })),
    refreshGroupTaskIntegrationState: vi.fn(async () => ({ record, preview })),
  };
  const handlers = new Map<string, Handler>();
  const assertTrustedSender = vi.fn((event: TrustedSenderEvent) => {
    if (!(event as unknown as { trusted?: boolean }).trusted)
      throw new Error("Blocked IPC call from untrusted renderer frame.");
  });
  return { service, handlers, assertTrustedSender };
}

const trusted = { trusted: true } as unknown as TrustedSenderEvent;
const untrusted = { trusted: false } as unknown as TrustedSenderEvent;

async function register(
  result = setup(),
  emitIntegrationEvent: (event: GroupRuntimeEvent) => void = vi.fn(),
) {
  const { registerGroupIntegrationIpcHandlers } = await import("./group-integration-ipc");
  registerGroupIntegrationIpcHandlers(
    { handle: (channel: string, handler: Handler) => result.handlers.set(channel, handler) },
    result.assertTrustedSender,
    result.service,
    emitIntegrationEvent,
  );
  return { ...result, emitIntegrationEvent };
}

describe("group integration IPC", () => {
  afterEach(() => vi.restoreAllMocks());

  it("registers trusted preview, confirmed apply, abort, and persisted state channels", async () => {
    const { handlers } = await register();
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.groupIntegrationPreview,
        IPC_CHANNELS.groupIntegrationApply,
        IPC_CHANNELS.groupIntegrationAbort,
        IPC_CHANNELS.groupIntegrationState,
        IPC_CHANNELS.groupIntegrationRefresh,
      ].sort(),
    );
  });

  it("asserts the trusted sender before parsing or touching any service method", async () => {
    const result = await register();
    const methods = [
      result.service.previewGroupTaskIntegration,
      result.service.applyGroupTaskIntegration,
      result.service.abortGroupTaskIntegration,
      result.service.getIntegrationState,
      result.service.refreshGroupTaskIntegrationState,
    ];
    for (const handler of result.handlers.values()) {
      expect(() => handler(untrusted, { taskId: "t-1" })).toThrow("Blocked IPC call");
      expect(result.assertTrustedSender).toHaveBeenCalledWith(untrusted);
      for (const method of methods) expect(method).not.toHaveBeenCalled();
    }
  });

  it("rejects paths, forged branch claims, extra fields, and missing apply confirmation", async () => {
    const { handlers, service } = await register();
    const previewHandler = handlers.get(IPC_CHANNELS.groupIntegrationPreview);
    const stateHandler = handlers.get(IPC_CHANNELS.groupIntegrationState);
    const refreshHandler = handlers.get(IPC_CHANNELS.groupIntegrationRefresh);
    const applyHandler = handlers.get(IPC_CHANNELS.groupIntegrationApply);
    const abortHandler = handlers.get(IPC_CHANNELS.groupIntegrationAbort);

    for (const payload of [
      { taskId: "t-1", cwd: "/tmp/repo" },
      { taskId: "t-1", sourceBranch: "attacker-branch" },
      { taskId: "t-1", targetPath: "/tmp/target" },
    ]) {
      expect(() => previewHandler?.(trusted, payload)).toThrow(/Invalid IPC payload/);
    }
    expect(() => stateHandler?.(trusted, { taskId: "t-1", path: "/tmp/repo" })).toThrow(
      /Invalid IPC payload/,
    );
    expect(() => refreshHandler?.(trusted, { taskId: "t-1", cwd: "/tmp/repo" })).toThrow(
      /Invalid IPC payload/,
    );
    expect(() => abortHandler?.(trusted, { taskId: "t-1", cwd: "/tmp/repo" })).toThrow(
      /Invalid IPC payload/,
    );
    for (const payload of [
      { taskId: "t-1", previewId: "preview-1" },
      { taskId: "t-1", previewId: "preview-1", confirmedByUser: false },
      {
        taskId: "t-1",
        previewId: "preview-1",
        confirmedByUser: true,
        targetBranch: "attacker-branch",
      },
    ]) {
      expect(() => applyHandler?.(trusted, payload)).toThrow(/Invalid IPC payload/);
    }
    expect(service.previewGroupTaskIntegration).not.toHaveBeenCalled();
    expect(service.applyGroupTaskIntegration).not.toHaveBeenCalled();
    expect(service.abortGroupTaskIntegration).not.toHaveBeenCalled();
    expect(service.getIntegrationState).not.toHaveBeenCalled();
  });

  it("forwards only task and preview identifiers plus the explicit user confirmation", async () => {
    const { handlers, service } = await register();
    await expect(
      handlers.get(IPC_CHANNELS.groupIntegrationPreview)?.(trusted, { taskId: "t-1" }),
    ).resolves.toBe(preview);
    expect(
      await handlers.get(IPC_CHANNELS.groupIntegrationApply)?.(trusted, {
        taskId: "t-1",
        previewId: "preview-1",
        confirmedByUser: true,
      }),
    ).toEqual({ ...record, status: "applied", version: 4 });
    await expect(
      handlers.get(IPC_CHANNELS.groupIntegrationAbort)?.(trusted, { taskId: "t-1" }),
    ).resolves.toEqual({ ...record, status: "aborted", version: 5 });
    expect(handlers.get(IPC_CHANNELS.groupIntegrationState)?.(trusted, { taskId: "t-1" })).toEqual({
      record,
      preview,
    });
    await expect(
      handlers.get(IPC_CHANNELS.groupIntegrationRefresh)?.(trusted, { taskId: "t-1" }),
    ).resolves.toEqual({ record, preview });
    expect(service.previewGroupTaskIntegration).toHaveBeenCalledWith("t-1");
    expect(service.applyGroupTaskIntegration).toHaveBeenCalledWith({
      taskId: "t-1",
      previewId: "preview-1",
      confirmedByUser: true,
    });
    expect(service.abortGroupTaskIntegration).toHaveBeenCalledWith("t-1");
    expect(service.getIntegrationState).toHaveBeenCalledWith("t-1");
    expect(service.refreshGroupTaskIntegrationState).toHaveBeenCalledWith("t-1");
  });

  it("keeps typed Group errors across rejected integration calls", async () => {
    const denied = Object.assign(new Error("Git integration was denied by the user."), {
      name: "GroupStoreError",
      code: "permission-denied",
    });
    const base = setup();
    const result = await register({
      ...base,
      service: {
        ...base.service,
        applyGroupTaskIntegration: vi.fn(async () => {
          throw denied;
        }),
      },
    });
    await expect(
      result.handlers.get(IPC_CHANNELS.groupIntegrationApply)?.(trusted, {
        taskId: "t-1",
        previewId: "preview-1",
        confirmedByUser: true,
      }),
    ).rejects.toThrow("[group-error:permission-denied] Git integration was denied by the user.");
  });

  it("builds a versioned integration-change event from the durable record", async () => {
    const { integrationChangedEvent } = await import("./group-integration-ipc");
    const event = integrationChangedEvent(record);
    expect(event satisfies GroupRuntimeEvent).toEqual({
      type: "group.integration-changed",
      groupId: "g-1",
      taskId: "t-1",
      record,
      version: record.version,
    });
  });

  it("emits the durable versioned event after preview, apply, and abort complete", async () => {
    const events: GroupRuntimeEvent[] = [];
    const result = await register(setup(), (event) => events.push(event));

    await result.handlers.get(IPC_CHANNELS.groupIntegrationPreview)?.(trusted, { taskId: "t-1" });
    await result.handlers.get(IPC_CHANNELS.groupIntegrationApply)?.(trusted, {
      taskId: "t-1",
      previewId: "preview-1",
      confirmedByUser: true,
    });
    await result.handlers.get(IPC_CHANNELS.groupIntegrationAbort)?.(trusted, { taskId: "t-1" });

    expect(events).toEqual([
      {
        type: "group.integration-changed",
        groupId: "g-1",
        taskId: "t-1",
        record,
        version: record.version,
      },
      {
        type: "group.integration-changed",
        groupId: "g-1",
        taskId: "t-1",
        record: { ...record, status: "applied", version: 4 },
        version: 4,
      },
      {
        type: "group.integration-changed",
        groupId: "g-1",
        taskId: "t-1",
        record: { ...record, status: "aborted", version: 5 },
        version: 5,
      },
    ]);
  });
});
