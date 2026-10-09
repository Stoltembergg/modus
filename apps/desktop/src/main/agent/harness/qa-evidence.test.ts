import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  controlledAgentCommand,
  parseControlledNpmCheck,
} from "../../terminal/agent-command-policy";
import {
  bindRunQAtoWorkspaceRevision,
  type RunQAEvent,
  recognizeCheckInvocation,
  summarizeRunQA,
} from "./qa-evidence";

const sessionId = "session-safe-1";
const runId = "run-safe-1";
const manifestReadHook = vi.hoisted(() => ({
  afterRead: undefined as (() => void) | undefined,
  beforeAccess: undefined as ((path: unknown) => void) | undefined,
  statOwner: undefined as { path: string; uid: number } | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: (...args: Parameters<typeof actual.accessSync>) => {
      manifestReadHook.beforeAccess?.(args[0]);
      return actual.accessSync(...args);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const value = actual.statSync(...args);
      const owner = manifestReadHook.statOwner;
      if (value && owner && args[0] === owner.path) {
        value.uid = typeof value.uid === "bigint" ? BigInt(owner.uid) : owner.uid;
      }
      return value;
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const content = actual.readFileSync(...args);
      manifestReadHook.afterRead?.();
      return content;
    },
  };
});

describe("controlled package execution", () => {
  it.each(["bash", "terminal_run"])("does not certify npx/npm exec through %s", (tool) => {
    for (const command of [
      "npx vitest run",
      "npx tsc --noEmit",
      "npx eslint .",
      "npx vite build",
      "npx biome check",
      "npx jest",
      "npx mocha",
      "npm exec -- vitest run",
    ]) {
      expect(recognizeCheckInvocation(tool, command)).toBeUndefined();
      const qa = summarize(commandPair(command, tool));
      expect(qa).toMatchObject({ status: "missing" });
      expect(qa.evidence.every((reference) => reference.status !== "passed")).toBe(true);
    }
    expect(recognizeCheckInvocation(tool, "vitest run")?.checkName).toBe("tests");
    expect(recognizeCheckInvocation(tool, "tsc --noEmit")?.checkName).toBe("typecheck");
  });
  it("does not certify a package script whose body executes npx", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "modus-npx-package-body-"));
    try {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "npx vitest run" } }),
      );
      expect(recognizeCheckInvocation("terminal_run", "npm test", cwd)).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it.each([
    "npm --script-shell=/bin/true test",
    "npm --workspaces test",
    "npm --prefix=/other test",
    "npm --workspace @unknown/package test",
    "npm --workspace @modus/desktop -w @modus/desktop test",
    "npm test -- --run",
    "NPM TEST",
  ])("never certifies an npm command left unchanged by the runner: %s", async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), "modus-package-grammar-"));
    try {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      expect(parseControlledNpmCheck(command)).toBeUndefined();
      expect(controlledAgentCommand(command, cwd)).toBe(command);
      expect(recognizeCheckInvocation("terminal_run", command, cwd)).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it.each([
    ["bash", "npm test"],
    ["terminal_run", "pnpm test"],
    ["terminal_run", "yarn test"],
  ])("does not certify package scripts from uncontrolled %s: %s", async (tool, command) => {
    const cwd = await mkdtemp(join(tmpdir(), "modus-uncontrolled-package-"));
    try {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      expect(recognizeCheckInvocation(tool, command, cwd)).toBeUndefined();
      expect(recognizeCheckInvocation(tool, "vitest run", cwd)?.checkName).toBe("tests");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("manifest read consistency", () => {
  it.skipIf(!process.getuid)(
    "observes ancestors conservatively when uid and ACL ownership are unknown",
    async () => {
      const sandbox = await mkdtemp(join(tmpdir(), "modus-unknown-uid-"));
      const container = join(sandbox, "container");
      const cwd = join(container, "project");
      mkdirSync(cwd, { recursive: true });
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      const uidSpy = vi.spyOn(process, "getuid").mockReturnValue(undefined as unknown as number);
      manifestReadHook.beforeAccess = () => {
        const error = new Error(
          "ACL write access denied, ownership unknown",
        ) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      };
      try {
        const before = recognizeCheckInvocation("terminal_run", "npm test", cwd);
        expect(before?.checkName).toBe("tests");
        mkdirSync(join(container, "changed-topology"));
        const after = recognizeCheckInvocation("terminal_run", "npm test", cwd);
        expect(after?.checkName).toBe("tests");
        expect(after?.packageConfigDigest).not.toBe(before?.packageConfigDigest);
      } finally {
        manifestReadHook.beforeAccess = undefined;
        uidSpy.mockRestore();
        await rm(sandbox, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(!process.getuid)(
    "observes sibling churn for a leaf directly inside the sticky temporary directory",
    async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "modus-direct-leaf-root-"));
      chmodSync(temporaryRoot, 0o1777);
      const cwd = await mkdtemp(join(temporaryRoot, "modus-direct-leaf-churn-"));
      let sibling: string | undefined;
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      const uid = 2 ** 31 - 1;
      const uidSpy = vi.spyOn(process, "getuid").mockReturnValue(uid);
      manifestReadHook.statOwner = { path: realpathSync(cwd), uid };
      const protectedParent = dirname(realpathSync(temporaryRoot));
      manifestReadHook.beforeAccess = (path) => {
        if (path === protectedParent) {
          const error = new Error(
            "Global ancestor cannot be renamed by this uid",
          ) as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      };
      try {
        const before = recognizeCheckInvocation("terminal_run", "npm test", cwd);
        expect(before?.checkName).toBe("tests");
        sibling = await mkdtemp(join(temporaryRoot, "modus-direct-leaf-sibling-"));
        const after = recognizeCheckInvocation("terminal_run", "npm test", cwd);
        expect(after?.checkName).toBe("tests");
        expect(after?.packageConfigDigest).not.toBe(before?.packageConfigDigest);
      } finally {
        manifestReadHook.beforeAccess = undefined;
        manifestReadHook.statOwner = undefined;
        uidSpy.mockRestore();
        if (sibling) await rm(sibling, { recursive: true, force: true });
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(!process.getuid)(
    "fails closed on temporary ancestor churn when running as root",
    async () => {
      const sandbox = await mkdtemp(join(tmpdir(), "modus-root-ancestor-"));
      const cwd = join(sandbox, "container", "project");
      mkdirSync(cwd, { recursive: true });
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      let sibling: string | undefined;
      const uidSpy = vi.spyOn(process, "getuid").mockReturnValue(0);
      try {
        const before = recognizeCheckInvocation("terminal_run", "npm test", cwd);
        expect(before?.checkName).toBe("tests");
        sibling = await mkdtemp(join(sandbox, "modus-root-sibling-"));
        const after = recognizeCheckInvocation("terminal_run", "npm test", cwd);
        expect(after?.checkName).toBe("tests");
        expect(after?.packageConfigDigest).not.toBe(before?.packageConfigDigest);
      } finally {
        uidSpy.mockRestore();
        if (sibling) await rm(sibling, { recursive: true, force: true });
        await rm(sandbox, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(!process.getuid)(
    "observes an ancestor whose owner can chmod its unwritable parent",
    async () => {
      const sandbox = await mkdtemp(join(tmpdir(), "modus-parent-owner-"));
      const ownedParent = join(sandbox, "owned-parent");
      const container = join(ownedParent, "container");
      const cwd = join(container, "project");
      mkdirSync(cwd, { recursive: true });
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      const simulatedUid = 2 ** 31 - 1;
      const uidSpy = vi.spyOn(process, "getuid").mockReturnValue(simulatedUid);
      manifestReadHook.statOwner = { path: ownedParent, uid: simulatedUid };
      manifestReadHook.beforeAccess = (path) => {
        if (path === ownedParent) {
          const error = new Error("Parent has no write permission yet") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      };
      try {
        const before = recognizeCheckInvocation("terminal_run", "npm test", cwd);
        expect(before?.checkName).toBe("tests");
        // Change only the container, preserving the parent's identity and the leaf's contents.
        mkdirSync(join(container, "changed-topology"));
        const after = recognizeCheckInvocation("terminal_run", "npm test", cwd);
        expect(after?.checkName).toBe("tests");
        expect(after?.packageConfigDigest).not.toBe(before?.packageConfigDigest);
      } finally {
        manifestReadHook.beforeAccess = undefined;
        manifestReadHook.statOwner = undefined;
        uidSpy.mockRestore();
        await rm(sandbox, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(!process.getuid)(
    "ignores sibling temporary artifacts when the ancestor is protected",
    async () => {
      const sandbox = await mkdtemp(join(tmpdir(), "modus-protected-ancestor-"));
      const cwd = join(sandbox, "container", "project");
      mkdirSync(cwd, { recursive: true });
      let sibling: string | undefined;
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      const protectedParent = dirname(realpathSync(tmpdir()));
      // Simulate a uid that neither owns the global temporary directory nor can rename it.
      const uidSpy = vi.spyOn(process, "getuid").mockReturnValue(2 ** 31 - 1);
      manifestReadHook.beforeAccess = (path) => {
        if (path === protectedParent) {
          const error = new Error("Parent is not writable by this user") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      };
      try {
        const before = recognizeCheckInvocation("terminal_run", "npm test", cwd);
        expect(before?.checkName).toBe("tests");
        sibling = await mkdtemp(join(tmpdir(), "modus-unrelated-temp-"));
        expect(recognizeCheckInvocation("terminal_run", "npm test", cwd)?.packageConfigDigest).toBe(
          before?.packageConfigDigest,
        );
      } finally {
        manifestReadHook.beforeAccess = undefined;
        uidSpy.mockRestore();
        if (sibling) await rm(sibling, { recursive: true, force: true });
        await rm(sandbox, { recursive: true, force: true });
      }
    },
  );
  it.for([
    "root",
    "workspace",
  ])("rejects a %s manifest changed after its bytes are read", async (scope) => {
    const cwd = await mkdtemp(join(tmpdir(), "modus-read-consistency-"));
    const workspaceRoot = join(cwd, "apps", "desktop");
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run" },
        workspaces: ["apps/*"],
      }),
    );
    writeFileSync(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        name: "@modus/desktop",
        scripts: { typecheck: "tsc --noEmit" },
      }),
    );
    let reads = 0;
    manifestReadHook.afterRead = () => {
      reads += 1;
      if (reads !== (scope === "root" ? 1 : 2)) return;
      manifestReadHook.afterRead = undefined;
      writeFileSync(
        join(scope === "root" ? cwd : workspaceRoot, "package.json"),
        JSON.stringify({
          name: "@modus/desktop",
          scripts: { test: "node unsafe.js", typecheck: "node unsafe.js" },
        }),
      );
    };
    try {
      const command =
        scope === "root" ? "npm test" : "npm --workspace @modus/desktop run typecheck";
      expect(recognizeCheckInvocation("terminal_run", command, cwd)).toBeUndefined();
    } finally {
      manifestReadHook.afterRead = undefined;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function pair(overrides: Partial<Extract<RunQAEvent, { type: "tool.ended" }>> = {}): RunQAEvent[] {
  const started: RunQAEvent = {
    type: "tool.started",
    sessionId,
    runId,
    eventId: "event-start-1",
    toolCallId: "tool-call-1",
    toolName: "terminal_run",
    checkName: "tests",
    fullProject: true,
  };
  const ended: RunQAEvent = {
    type: "tool.ended",
    sessionId,
    runId,
    eventId: "event-end-1",
    toolCallId: "tool-call-1",
    toolName: "terminal_run",
    checkName: "tests",
    fullProject: true,
    exitCode: 0,
    ...overrides,
  };
  return [started, ended];
}

const summarize = (events: RunQAEvent[], changedPaths = ["src/a.ts"], requiredChecks = ["tests"]) =>
  summarizeRunQA({ sessionId, runId, changedPaths, requiredChecks, events });

describe("workspace-bound QA", () => {
  it("keeps a pass only while its start, end, and current source revisions match", () => {
    const revision = "a".repeat(64);
    const events = pair({ sourceStable: true, workspaceRevision: revision });
    const started = events[0];
    if (started?.type === "tool.started") started.workspaceRevision = revision;
    const result = summarize(events);

    expect(
      bindRunQAtoWorkspaceRevision({ result, events, workspaceRevision: revision }),
    ).toMatchObject({ status: "passed", evidence: [expect.objectContaining({ revision })] });
    expect(
      bindRunQAtoWorkspaceRevision({
        result,
        events,
        workspaceRevision: "b".repeat(64),
      }),
    ).toMatchObject({
      status: "unavailable",
      reasonCode: "required_check_unavailable",
      evidence: [expect.objectContaining({ status: "unavailable" })],
    });
  });

  it("rejects a pass when source content changed during the check or has no revision", () => {
    const revision = "c".repeat(64);
    const events = pair({ sourceStable: false, workspaceRevision: revision });
    const started = events[0];
    if (started?.type === "tool.started") started.workspaceRevision = revision;
    const result = summarize(events);

    expect(
      bindRunQAtoWorkspaceRevision({ result, events, workspaceRevision: revision }),
    ).toMatchObject({ status: "unavailable" });
    expect(
      bindRunQAtoWorkspaceRevision({ result, events, workspaceRevision: undefined }),
    ).toMatchObject({ status: "unavailable" });
  });
});

function commandPair(command: string, toolName = "terminal_run", paths?: string[]): RunQAEvent[] {
  const base = {
    sessionId,
    runId,
    toolCallId: `call-${command}`,
    toolName,
    command,
    ...(paths ? { paths } : {}),
  };
  return [
    { type: "tool.started", ...base, eventId: "start-command" },
    { type: "tool.ended", ...base, eventId: "end-command", exitCode: 0 },
  ];
}

describe("summarizeRunQA", () => {
  it("passes a recognized check only when a matching tool call starts and completes successfully", () => {
    expect(summarize(pair())).toMatchObject({ required: true, status: "passed" });
    expect(summarize(pair()).evidence).toEqual([
      expect.objectContaining({
        kind: "check",
        status: "passed",
        label: "Tests",
        checkName: "tests",
        eventId: "event-end-1",
        runId,
      }),
    ]);
  });

  it("marks a completed check with an error outcome failed", () => {
    expect(summarize(pair({ exitCode: 1 }))).toMatchObject({ required: true, status: "failed" });
  });

  it("does not treat a completed non-error call without a success result as passed", () => {
    const events = pair();
    delete (events[1] as Extract<RunQAEvent, { type: "tool.ended" }>).exitCode;
    expect(summarize(events)).toMatchObject({
      required: true,
      status: "unavailable",
      reasonCode: "required_check_unavailable",
    });
  });

  it("does not infer a bash check passed when its exit code is missing", () => {
    const events = pair();
    for (const event of events) {
      if (event.type === "tool.started" || event.type === "tool.ended") {
        event.toolName = "bash";
      }
    }
    const ended = events[1];
    if (ended?.type === "tool.ended") delete ended.exitCode;

    expect(summarize(events)).toMatchObject({
      required: true,
      status: "unavailable",
      reasonCode: "required_check_unavailable",
      evidence: [expect.objectContaining({ status: "unavailable" })],
    });
  });

  it("keeps a timed-out check distinct from a failed or unavailable check", () => {
    const events = pair();
    const ended = events[1];
    if (ended?.type === "tool.ended") {
      (ended as typeof ended & { timedOut: boolean }).timedOut = true;
      delete ended.exitCode;
    }

    expect(summarize(events)).toMatchObject({
      required: true,
      status: "timed_out",
      reasonCode: "required_check_timed_out",
      evidence: [expect.objectContaining({ status: "timed_out" })],
    });
  });

  it("keeps cancellation distinct from an unavailable check", () => {
    expect(summarize(pair({ aborted: true }))).toMatchObject({
      required: true,
      status: "cancelled",
      reasonCode: "required_check_cancelled",
      evidence: [expect.objectContaining({ status: "cancelled" })],
    });
  });

  it("keeps a check-named unknown tool without an exit result unavailable", () => {
    const unknownTool: RunQAEvent[] = [
      {
        type: "tool.started",
        sessionId,
        runId,
        eventId: "unknown-tool-start",
        toolCallId: "unknown-check-call",
        toolName: "custom_runner",
        checkName: "tests",
        fullProject: true,
      },
      {
        type: "tool.ended",
        sessionId,
        runId,
        eventId: "unknown-tool-end",
        toolCallId: "unknown-check-call",
        toolName: "custom_runner",
        checkName: "tests",
        fullProject: true,
        error: false,
      },
    ];
    expect(summarize(unknownTool)).toMatchObject({
      required: true,
      status: "unavailable",
      reasonCode: "required_check_unavailable",
    });
  });

  it("keeps a skipped check distinct from missing and failed evidence", () => {
    expect(summarize(pair({ skipped: true }))).toMatchObject({
      required: true,
      status: "skipped",
      reasonCode: "required_check_skipped",
    });
  });

  it("keeps manual confirmation distinct from an automated pass", () => {
    const confirmed: RunQAEvent = {
      type: "check.confirmed",
      sessionId,
      runId,
      eventId: "user-confirmed-check",
      checkName: "tests",
      paths: ["src/a.ts"],
    };
    expect(summarize([confirmed])).toMatchObject({
      required: true,
      status: "user_confirmed",
      reasonCode: "automated_check_unverified",
    });
  });

  it("does not let an ended event change the identity established by its start event", () => {
    expect(summarize(pair({ checkName: "typecheck" }), ["src/a.ts"], ["typecheck"])).toMatchObject({
      required: true,
      status: "missing",
      reasonCode: "required_check_missing",
    });
  });

  it.each([
    ["no result", ["tool.started"]],
    ["aborted result", ["tool.started", "aborted"]],
  ] as const)("does not pass a tool call with %s", (_name, shape) => {
    const events = pair();
    const firstEvent = events[0];
    const incomplete = shape[0] === "tool.started" && firstEvent ? [firstEvent] : events;
    if (shape[1] === "aborted") {
      incomplete.push({
        ...(events[1] as Extract<RunQAEvent, { type: "tool.ended" }>),
        aborted: true,
      });
    }
    expect(summarize(incomplete)).not.toMatchObject({ status: "passed" });
  });

  it("does not count an unrelated shell command as a check", () => {
    const events = pair().map((event) => {
      const { checkName: _checkName, ...withoutCheckName } = event;
      return { ...withoutCheckName, command: "echo hello" };
    }) as RunQAEvent[];
    expect(summarize(events)).toMatchObject({ status: "missing" });
  });

  it.each([
    ["echo npm test", "terminal_run"],
    ["printf 'vitest'", "terminal_run"],
    ['"npm test"', "terminal_run"],
    ["npm test", "untrusted_custom_tool"],
  ])("rejects mentioned check names in non-check invocation %s", (command, toolName) => {
    expect(summarize(commandPair(command, toolName))).toMatchObject({ status: "missing" });
  });

  it.each([
    "vitest run $VITEST_FLAGS",
    "vitest run $(printf -- --help)",
    "vitest run `eslint --fix .`",
    "vitest run src/**/*.test.ts",
    "vitest run {--help,--run}",
    "vitest run ~/test-options",
  ])("rejects direct check commands with shell expansion: %s", (command) => {
    expect(recognizeCheckInvocation("terminal_run", command)).toBeUndefined();
    expect(summarize(commandPair(command))).toMatchObject({ status: "missing" });
  });

  it.each([
    "vitest run $VITEST_FLAGS",
    "vitest run $(printf -- --help)",
    "vitest run `eslint --fix .`",
  ])("does not accept an expanding package test script body: %s", async (body) => {
    const cwd = await mkdtemp(join(tmpdir(), "modus-qa-script-expansion-"));
    try {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: body } }));
      expect(recognizeCheckInvocation("terminal_run", "npm test", cwd)).toBeUndefined();
      expect(summarize(commandPair("npm test"))).toMatchObject({ status: "missing" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    "vitest run",
    "vitest run --root .",
    "jest",
    "bash",
  ])("recognizes a supported full-project check invocation %s", (command) => {
    const events = command === "bash" ? commandPair("vitest run", "bash") : commandPair(command);
    expect(summarize(events)).toMatchObject({ status: "passed" });
  });

  it.each([
    ["tsc --noEmit", "typecheck"],
    ["eslint .", "lint"],
    ["vite build", "build"],
  ] as const)("treats safe direct command %s as full-project QA", (command, check) => {
    expect(summarize(commandPair(command), ["src/a.ts"], [check])).toMatchObject({
      status: "passed",
    });
  });

  it.each([
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run typecheck",
    "npm run build",
  ])("does not trust an unresolved package-script name: %s", (command) => {
    expect(
      summarize(
        commandPair(command),
        [],
        [
          command.includes("typecheck")
            ? "typecheck"
            : command.includes("lint")
              ? "lint"
              : command.includes("build")
                ? "build"
                : "tests",
        ],
      ),
    ).toMatchObject({
      required: true,
      status: "missing",
    });
  });

  it.each([
    "vitest run --help",
    "vitest run -h",
    "vitest run --version",
    "vitest run -v",
    "npm test -- --help",
    "npm test -- -h",
    "npm test -- --version",
    "npm test -- -v",
  ])("does not treat non-executing help/version command %s as check evidence", (command) => {
    const result = summarize(commandPair(command));
    expect(result).toMatchObject({ required: true, status: "missing" });
    expect(result.evidence).toEqual([expect.objectContaining({ status: "missing" })]);
  });

  it.each([
    "vitest list",
    "npx vitest list",
    "jest --listTests",
    "jest --list",
    "jest --list-tests",
    "jest --showConfig",
    "npm test -- --listTests",
    "npm test -- --list",
    "npm test -- --list-tests",
    "npm test -- --showConfig",
  ])("does not treat list-only invocation %s as executed check evidence", (command) => {
    const result = summarize(commandPair(command), [], ["tests"]);
    expect(result).toMatchObject({ required: true, status: "missing" });
    expect(result.evidence).toEqual([expect.objectContaining({ status: "missing" })]);
  });

  it.each([
    "npm --workspace @modus/desktop run typecheck",
    "npm -w @modus/desktop run typecheck",
    "npm --workspace=@modus/desktop run typecheck",
    "npm -w=@modus/desktop run typecheck",
  ])("recognizes exact workspace check invocation %s with workspace-scoped coverage", (command) => {
    expect(
      summarize(commandPair(command), ["apps/desktop/src/main/file.ts"], ["typecheck"]),
    ).toMatchObject({ status: "missing" });
    expect(
      summarize(commandPair(command), ["apps/other/src/file.ts"], ["typecheck"]),
    ).toMatchObject({ status: "missing" });
  });

  it("does not recognize workspace mentions for unknown packages or quoted invocations", () => {
    expect(
      summarize(
        commandPair("npm --workspace @unknown/package run typecheck"),
        ["apps/a.ts"],
        ["typecheck"],
      ),
    ).toMatchObject({ status: "missing" });
    expect(
      summarize(
        commandPair('echo "npm --workspace @modus/desktop run typecheck"'),
        ["apps/desktop/a.ts"],
        ["typecheck"],
      ),
    ).toMatchObject({ status: "missing" });
  });

  it("does not treat missing scope as blanket coverage for scoped checks", () => {
    expect(summarize(commandPair("vitest run src/one.test.ts"), ["src/a.ts"])).toMatchObject({
      status: "unavailable",
    });
    expect(
      summarize(commandPair("vitest run src/one.test.ts", "terminal_run", ["src/a.ts"]), [
        "src/a.ts",
      ]),
    ).toMatchObject({ status: "passed" });
  });

  it("invalidates a completed check when a later source write or unclassified shell action occurs", () => {
    const check = pair();
    const edit: RunQAEvent = {
      type: "tool.started",
      sessionId,
      runId,
      eventId: "later-edit",
      toolCallId: "edit-call",
      toolName: "edit",
      paths: ["src/a.ts"],
    };
    const shell: RunQAEvent = {
      type: "tool.started",
      sessionId,
      runId,
      eventId: "later-shell",
      toolCallId: "shell-call",
      toolName: "bash",
      command: "echo unrelated",
    };
    expect(summarize([...check, edit])).toMatchObject({ status: "missing" });
    expect(summarize([...check, shell])).toMatchObject({ status: "missing" });
    expect(summarize([edit, ...commandPair("vitest run")])).toMatchObject({ status: "passed" });
  });

  it.each([
    "biome check --write src/a.ts",
    "eslint --fix src/a.ts",
    "npx biome check --write src/a.ts",
    "npx eslint --fix src/a.ts",
    "npm run lint -- --fix",
    "npm run lint -- --apply",
    "npm run lint -- --apply=unsafe",
  ])("invalidates earlier check evidence for a source-mutating invocation: %s", (fixCommand) => {
    const result = summarize([...commandPair("npm test"), ...commandPair(fixCommand)]);
    expect(result).toMatchObject({ required: true, status: "missing" });
    expect(result.evidence).toEqual([expect.objectContaining({ status: "missing" })]);
  });

  it.each([
    "vitest run -u",
    "vitest run --update",
    "jest -u",
    "jest --updateSnapshot",
    "npx vitest run -u",
  ])("does not certify a test invocation that updates snapshots: %s", (command) => {
    expect(recognizeCheckInvocation("terminal_run", command)).toMatchObject({
      checkName: "tests",
      mutatesSource: true,
    });
    expect(summarize([...commandPair("npm test"), ...commandPair(command)])).toMatchObject({
      required: true,
      status: "missing",
      evidence: [expect.objectContaining({ status: "missing" })],
    });
  });

  it("allows a fresh non-mutating check after a source-mutating invocation to pass", () => {
    const result = summarize([
      ...commandPair("vitest run"),
      ...commandPair("npm run lint -- --fix"),
      ...commandPair("vitest run"),
    ]);
    expect(result).toMatchObject({ required: true, status: "passed" });
    expect(result.evidence).toEqual([expect.objectContaining({ status: "passed" })]);
  });

  it("allows a fresh check after an apply fixer but does not treat the fixer as the pass", () => {
    const result = summarize([
      ...commandPair("vitest run"),
      ...commandPair("npm run lint -- --apply=unsafe"),
      ...commandPair("vitest run"),
    ]);
    expect(result).toMatchObject({ status: "passed" });
    expect(result.evidence).toEqual([
      expect.objectContaining({ status: "passed", eventId: "end-command" }),
    ]);
  });

  it("returns only safe references and labels, never command output or secrets", () => {
    const events = pair({
      output: "TOKEN=super-secret raw output",
      command: "npm test --token=super-secret",
    });
    const serialized = JSON.stringify(summarize(events));
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("raw output");
    expect(serialized).not.toContain("npm test");
  });

  it("invalidates evidence when the check did not cover the changed paths", () => {
    const events = pair({ paths: ["src/old.ts"] });
    expect(summarize(events, ["src/new.ts"])).toMatchObject({ status: "unavailable" });
  });

  it("keeps missing required checks distinct", () => {
    const result = summarize([], ["src/a.ts"], ["tests", "typecheck"]);

    expect(result).toMatchObject({
      required: true,
      status: "missing",
      reasonCode: "required_check_missing",
    });
    expect(result.evidence).toEqual([
      expect.objectContaining({ status: "missing", label: "Tests" }),
      expect.objectContaining({ status: "missing", label: "Typecheck" }),
    ]);
    for (const evidence of result.evidence) {
      expect(evidence).not.toHaveProperty("id");
      expect(evidence).not.toHaveProperty("eventId");
    }
  });

  it("keeps an unknown-only required check as an unmet obligation without exposing its name", () => {
    const result = summarize([], ["src/a.ts"], ["private-command --token=secret-value"]);

    expect(result).toMatchObject({ required: true, status: "missing" });
    expect(["passed", "not_required"]).not.toContain(result.status);
    expect(result.evidence).toEqual([
      expect.objectContaining({ status: "missing", label: "Required check" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("private-command");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("does not discard an unknown required check when a recognized check passes", () => {
    const result = summarize(pair(), ["src/a.ts"], ["tests", "private-check-name"]);

    expect(result).toMatchObject({ required: true });
    expect(["passed", "not_required"]).not.toContain(result.status);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Tests", status: "passed" }),
        expect.objectContaining({ label: "Required check", status: "missing" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("private-check-name");
  });

  it("does not force automated QA for a simple task with no required checks", () => {
    expect(summarize([], ["src/a.ts"], [])).toEqual({
      required: false,
      status: "not_required",
      reasonCode: "qa_not_required",
      evidence: [],
    });
  });
});
