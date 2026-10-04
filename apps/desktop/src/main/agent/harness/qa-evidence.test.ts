import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type RunQAEvent, recognizeCheckInvocation, summarizeRunQA } from "./qa-evidence";

const sessionId = "session-safe-1";
const runId = "run-safe-1";

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
    "npx vitest run",
    "npx vitest run --root .",
    "bash",
  ])("recognizes a supported full-project check invocation %s", (command) => {
    const events =
      command === "bash" ? commandPair("npx vitest run", "bash") : commandPair(command);
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
    "npx vitest run --help",
    "npx vitest run -h",
    "npx vitest run --version",
    "npx vitest run -v",
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
    expect(summarize(commandPair("npx vitest run src/one.test.ts"), ["src/a.ts"])).toMatchObject({
      status: "missing",
    });
    expect(
      summarize(commandPair("npx vitest run src/one.test.ts", "terminal_run", ["src/a.ts"]), [
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
    expect(summarize([edit, ...commandPair("npx vitest run")])).toMatchObject({ status: "passed" });
  });

  it.each([
    "biome check --write src/a.ts",
    "eslint --fix src/a.ts",
    "npm run lint -- --fix",
    "npm run lint -- --apply",
    "npm run lint -- --apply=unsafe",
  ])("invalidates earlier check evidence for a source-mutating invocation: %s", (fixCommand) => {
    const result = summarize([...commandPair("npm test"), ...commandPair(fixCommand)]);
    expect(result).toMatchObject({ required: true, status: "missing" });
    expect(result.evidence).toEqual([expect.objectContaining({ status: "missing" })]);
  });

  it("allows a fresh non-mutating check after a source-mutating invocation to pass", () => {
    const result = summarize([
      ...commandPair("npx vitest run"),
      ...commandPair("npm run lint -- --fix"),
      ...commandPair("npx vitest run"),
    ]);
    expect(result).toMatchObject({ required: true, status: "passed" });
    expect(result.evidence).toEqual([expect.objectContaining({ status: "passed" })]);
  });

  it("allows a fresh check after an apply fixer but does not treat the fixer as the pass", () => {
    const result = summarize([
      ...commandPair("npx vitest run"),
      ...commandPair("npm run lint -- --apply=unsafe"),
      ...commandPair("npx vitest run"),
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
    expect(summarize(events, ["src/new.ts"])).toMatchObject({ status: "missing" });
  });

  it("keeps missing required checks distinct", () => {
    expect(summarize([], ["src/a.ts"], ["tests", "typecheck"])).toMatchObject({
      required: true,
      status: "missing",
      reasonCode: "required_check_missing",
    });
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
