import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRunTokenUsage } from "../../src/shared/contracts";
import { QUALITY_FIXTURES, verifyFixture } from "./fixtures";
import { QualityRunReporter } from "./report";
import { fixtureFilePath, fixtureToolDecision } from "./scope";

describe("quality fixture independent verifiers", () => {
  const correctFiles: Record<string, Record<string, string>> = {
    "policy-answer-en": { "answer.json": '{"retryLimit":3,"backoffMs":200}' },
    "repair-config-pt": {
      "config.json":
        '{"port":8080,"retries":2,"enabled":false,"metadata":{"owner":"Ana","labels":["ação","beta"]}}',
    },
    "aggregate-csv-en": { "totals.json": '{"books":1800,"games":3000,"total":4800}' },
    "release-notes-pt": {
      "NOTAS.md":
        "# Versão 2.1\n\n## Correções\n- Preserva acentos na exportação.\n\n## Melhorias\n- Adiciona filtro por data.\n",
    },
    "consistent-catalog-en": {
      "products.json":
        '[{"id":"p1","name":"Notebook","priceCents":500},{"id":"p2","name":"Travel mug","priceCents":1200}]',
      "featured.json": '{"productId":"p2","label":"Travel mug","rank":1}',
    },
    "delegate-inventory-pt": { "estoque.json": '{"depositoA":11,"depositoB":10,"total":21}' },
    "repair-command-line-pt": {
      "command-line.ts": readFileSync(
        new URL("./code-repair/reference.ts.txt", import.meta.url),
        "utf8",
      ),
    },
  };

  for (const fixture of QUALITY_FIXTURES) {
    it(`${fixture.id} accepts the independent expected result and rejects untouched work`, () => {
      const good = {
        files: { ...fixture.files, ...correctFiles[fixture.id] },
        childSessions: 1,
        successfulWaits: 1,
      };
      expect(verifyFixture(fixture, good).every((check) => check.passed)).toBe(true);
      expect(
        verifyFixture(fixture, { ...good, files: fixture.files }).some((check) => !check.passed),
      ).toBe(true);
      expect(
        verifyFixture(fixture, {
          ...good,
          files: { ...good.files, "unexpected.txt": "extra" },
        }).some((check) => !check.passed),
      ).toBe(true);
    });
  }

  it("rejects changed inputs, extra JSON fields, and delegation without a child or wait", () => {
    const answer = QUALITY_FIXTURES[0];
    if (!answer) throw new Error("Missing answer fixture");
    const good = { ...answer.files, ...correctFiles[answer.id] };
    expect(
      verifyFixture(answer, {
        files: { ...good, "settings.json": "{}" },
        childSessions: 0,
        successfulWaits: 0,
      }).every((check) => check.passed),
    ).toBe(false);
    expect(
      verifyFixture(answer, {
        files: { ...good, "answer.json": '{"retryLimit":3,"backoffMs":200,"guessed":true}' },
        childSessions: 0,
        successfulWaits: 0,
      }).every((check) => check.passed),
    ).toBe(false);
    const delegation = QUALITY_FIXTURES.find((fixture) => fixture.delegate);
    if (!delegation) throw new Error("Missing delegation fixture");
    expect(
      verifyFixture(delegation, {
        files: { ...delegation.files, ...correctFiles[delegation.id] },
        childSessions: 0,
        successfulWaits: 0,
      }).filter((check) => !check.passed),
    ).toHaveLength(2);
  });
});

describe("quality runtime event reporter", () => {
  const usage: AgentRunTokenUsage = {
    input: 10,
    output: 3,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 15,
  };
  const started = (sessionId: string, runId: string): AgentEvent => ({
    type: "run.started",
    sessionId,
    runId,
    delivery: "normal",
  });
  const completed = (sessionId: string, runId: string): AgentEvent => ({
    type: "run.completed",
    sessionId,
    runId,
    tokenUsage: usage,
    responseModel: { provider: "chosen", model: "model" },
  });

  it("counts parent and child usage once, preserving independent elapsed times", () => {
    const reporter = new QualityRunReporter();
    reporter.observe(started("parent", "p"), 10);
    reporter.observe(started("child", "c"), 12);
    reporter.observe(completed("child", "c"), 32);
    reporter.observe(completed("parent", "p"), 40);
    reporter.observe(completed("child", "c"), 99);
    reporter.observe(completed("unrelated", "u"), 100);
    const result = reporter.snapshot("parent", ["child"]);
    expect(result.parent.totalUsage).toEqual(usage);
    expect(result.children.totalUsage).toEqual(usage);
    expect(result.combined.totalUsage?.totalTokens).toBe(30);
    expect(result.runs.map((run) => run.elapsedMs)).toEqual([30, 20]);
  });

  it("does not turn missing usage or unsettled runs into known zero usage", () => {
    const reporter = new QualityRunReporter();
    reporter.observe(started("parent", "p"), 0);
    reporter.observe(completed("parent", "p"), 10);
    reporter.observe(started("child", "c"), 1);
    const result = reporter.snapshot("parent", ["child"]);
    expect(result.combined.usageComplete).toBe(false);
    expect(result.combined.totalUsage).toBeNull();
    expect(result.combined.reportedUsage).toEqual(usage);
    expect(result.children.missingUsageRunIds).toEqual(["c"]);
    expect(result.runs[1]?.status).toBe("unsettled");
    expect(result.runs[1]?.elapsedMs).toBeNull();
    expect(new QualityRunReporter().snapshot("p", []).combined.totalUsage).toBeNull();
  });

  it("includes failed/cancelled inference usage and rejects invalid counters", () => {
    const reporter = new QualityRunReporter();
    reporter.observe(
      { type: "run.failed", sessionId: "parent", runId: "p", message: "failed", tokenUsage: usage },
      5,
    );
    reporter.observe(
      {
        type: "run.cancelled",
        sessionId: "child",
        runId: "c",
        tokenUsage: { ...usage, input: -1 },
      },
      5,
    );
    const result = reporter.snapshot("parent", ["child"]);
    expect(result.parent.totalUsage).toEqual(usage);
    expect(result.combined.totalUsage).toBeNull();
    expect(result.runs[0]?.elapsedMs).toBeNull();
  });

  it.each([
    ["timed out", { timedOut: true }],
    ["aborted", { aborted: true }],
    ["skipped", { skipped: true }],
    ["errored", { isError: true }],
  ] as const)("does not count a %s wait as successful delegation", (_label, outcome) => {
    const reporter = new QualityRunReporter();
    reporter.observe(
      {
        type: "tool.ended",
        sessionId: "parent",
        runId: "parent-run",
        toolCallId: "wait-call",
        toolName: "wait",
        isError: false,
        ...outcome,
      },
      10,
    );

    expect(reporter.successfulWaits).toBe(0);
  });

  it("counts a completed wait as successful delegation", () => {
    const reporter = new QualityRunReporter();
    reporter.observe(
      {
        type: "tool.ended",
        sessionId: "parent",
        runId: "parent-run",
        toolCallId: "wait-call",
        toolName: "wait",
        isError: false,
      },
      10,
    );

    expect(reporter.successfulWaits).toBe(1);
  });
});

describe("quality fixture scope", () => {
  it("denies outside paths, undeclared files, symlinks, external tools and alternate child models", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-scope-"));
    try {
      await writeFile(join(root, "input.json"), "{}");
      await writeFile(join(root, "output.json"), "{}");
      const input = {
        root: resolve(root),
        files: ["input.json", "output.json"],
        writable: ["output.json"],
        selectedModel: "chosen/model",
        delegationAllowed: true,
        tasksStarted: 0,
      };
      const decide = (toolName: string, args: unknown) =>
        fixtureToolDecision({ ...input, toolName, args });
      expect(decide("read", { path: "input.json" })).toBeUndefined();
      expect(decide("write", { path: "output.json", content: "{}" })).toBeUndefined();
      expect(decide("write", { path: "input.json", content: "{}" })?.block).toBe(true);
      expect(decide("read", { path: "../input.json" })?.block).toBe(true);
      expect(decide("read", { path: "/etc/passwd" })?.block).toBe(true);
      expect(decide("read", { path: "new.json" })?.block).toBe(true);
      for (const tool of [
        "bash",
        "terminal_run",
        "web_fetch",
        "browser",
        "rea_call",
        "fast_codebase",
        "unknown",
      ])
        expect(decide(tool, {})?.block).toBe(true);
      expect(decide("task", { subagent: "explore", model: "inherit" })).toBeUndefined();
      expect(decide("task", { subagent: "explore", model: "other/model" })?.block).toBe(true);
      expect(decide("task", { subagent: "unknown" })?.block).toBe(true);
      expect(
        fixtureToolDecision({
          ...input,
          toolName: "task",
          args: { subagent: "explore" },
          tasksStarted: 1,
        })?.block,
      ).toBe(true);
      await symlink(join(root, "input.json"), join(root, "link.json"));
      expect(fixtureFilePath(root, "link.json", ["link.json"])).toBeUndefined();
      expect(decide("read", null)?.block).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
