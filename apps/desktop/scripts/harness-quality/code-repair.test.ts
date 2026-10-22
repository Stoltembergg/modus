import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODE_REPAIR_FIXTURE,
  CODE_REPAIR_PROVENANCE,
  COMMAND_LINE_CASES,
  verifyCommandLine,
} from "./code-repair";
import { type FixtureObservation, QUALITY_FIXTURES, verifyFixture } from "./fixtures";

const reference = readFileSync(new URL("./code-repair/reference.ts.txt", import.meta.url), "utf8");
const original = CODE_REPAIR_FIXTURE.files["command-line.ts"] ?? "";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const observation = (source: string): FixtureObservation => ({
  files: { ...CODE_REPAIR_FIXTURE.files, "command-line.ts": source },
  childSessions: 0,
  successfulWaits: 0,
});

describe("real repository code repair verifier", () => {
  it("pins unmodified real repository source and existing tests", () => {
    expect(hash(original)).toBe(CODE_REPAIR_PROVENANCE.sourceSha256);
    expect(hash(CODE_REPAIR_FIXTURE.files["command-line.test.ts"] ?? "")).toBe(
      CODE_REPAIR_PROVENANCE.testsSha256,
    );
    // Pin the historical snapshot, not today's product source: the real utility
    // can be fixed later without silently changing this evaluation's input.
    expect(QUALITY_FIXTURES.filter(({ id }) => id === CODE_REPAIR_FIXTURE.id)).toHaveLength(1);
    expect(Object.keys(CODE_REPAIR_FIXTURE.files)).not.toContain("reference.ts.txt");
  });

  it("reproduces the actual quote bug and accepts a behavioral repair", () => {
    const before = verifyCommandLine(original);
    expect(before.some(({ passed }) => !passed)).toBe(true);
    expect(before.find(({ name }) => name.endsWith("round trip 2"))?.passed).toBe(false);
    expect(before.slice(0, 7).every(({ passed }) => passed)).toBe(true);
    const after = verifyFixture(CODE_REPAIR_FIXTURE, observation(reference));
    expect(after.every(({ passed }) => passed)).toBe(true);
    expect(verifyCommandLine(reference)).toHaveLength(COMMAND_LINE_CASES.length);
  });

  it("accepts an equivalent repair rather than comparing source text", () => {
    expect(
      verifyCommandLine(`// Different source formatting\n${reference}`).every(
        ({ passed }) => passed,
      ),
    ).toBe(true);
  });

  it("rejects a hard-coded answer and cannot pass by modifying the visible tests", () => {
    expect(
      verifyCommandLine(
        'export const splitCommandLine = () => [\'a"b\']; export const joinCommandLine = () => "";',
      ).some(({ passed }) => !passed),
    ).toBe(true);
    const changed = observation(reference);
    changed.files["command-line.test.ts"] = "// deleted assertions";
    expect(verifyFixture(CODE_REPAIR_FIXTURE, changed).some(({ passed }) => !passed)).toBe(true);
  });

  it.each([
    ["syntax error", "export function ("],
    ["missing exports", "const unused = 1;"],
    ["host process access", "process.exit(0);"],
    ["host module access", 'require("node:fs").readFileSync("/etc/passwd");'],
    ["dynamic code", 'Function("return process")();'],
    ["oversized source", " ".repeat(64 * 1024 + 1)],
    [
      "excessive output",
      'export const splitCommandLine = () => ["x".repeat(70 * 1024)]; export const joinCommandLine = () => "x";',
    ],
  ])("fails closed for %s", (_label, source) => {
    expect(verifyCommandLine(source).some(({ passed }) => !passed)).toBe(true);
  });

  it("bounds non-terminating candidates", () => {
    expect(verifyCommandLine("while (true) {}").every(({ passed }) => !passed)).toBe(true);
  }, 5_000);
});

it("records an offline calibration baseline, never a live model score", () => {
  const sourceFiles = [
    "apps/desktop/scripts/harness-quality/fixtures.ts",
    "apps/desktop/scripts/harness-quality/code-repair.ts",
    "apps/desktop/scripts/harness-quality/code-repair.test.ts",
    "apps/desktop/scripts/harness-quality/quality.test.ts",
    "apps/desktop/scripts/harness-quality/report.ts",
    "apps/desktop/scripts/harness-quality/scope.ts",
    "apps/desktop/scripts/harness-quality/code-repair/command-line.ts.txt",
    "apps/desktop/scripts/harness-quality/code-repair/command-line.test.ts.txt",
    "apps/desktop/scripts/harness-quality/code-repair/reference.ts.txt",
    "apps/desktop/src/main/agent/harness/harness-quality.live.test.ts",
  ];
  const before = verifyFixture(CODE_REPAIR_FIXTURE, observation(original));
  const after = verifyFixture(CODE_REPAIR_FIXTURE, observation(reference));
  const baseline = {
    schemaVersion: 1,
    kind: "offline-verifier-calibration",
    inferenceExecuted: false,
    selectedModel: null,
    liveBaselineStatus: "not_run_requires_explicit_provider_model_choice",
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    nodeVersion: process.version,
    fixtureId: CODE_REPAIR_FIXTURE.id,
    fixtureHash: hash(
      JSON.stringify(QUALITY_FIXTURES.map(({ verify: _verify, ...fixture }) => fixture)),
    ),
    provenance: CODE_REPAIR_PROVENANCE,
    sourceHashes: Object.fromEntries(
      sourceFiles.map((path) => [path, hash(readFileSync(resolve(root, path)))]),
    ),
    command:
      "MODUS_HARNESS_QUALITY_LIVE=0 MODUS_HARNESS_QUALITY_BASELINE=docs/evaluations/harness-quality-code-repair-baseline.json node_modules/.bin/vitest run apps/desktop/scripts/harness-quality/code-repair.test.ts apps/desktop/scripts/harness-quality/quality.test.ts apps/desktop/src/shared/command-line.test.ts apps/desktop/src/main/agent/harness/harness-quality.live.test.ts",
    controls: [
      {
        candidate: "unmodified-repository-source",
        passed: before.every(({ passed }) => passed),
        checks: before,
      },
      {
        candidate: "reference-repair-not-a-model-output",
        passed: after.every(({ passed }) => passed),
        checks: after,
      },
    ],
  };
  expect(baseline.controls.map(({ passed }) => passed)).toEqual([false, true]);
  const output = process.env.MODUS_HARNESS_QUALITY_BASELINE;
  if (output) {
    const path = resolve(root, output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  }
  // The checked-in record is reproducible; refresh it explicitly after changes.
  const stored = JSON.parse(
    readFileSync(
      resolve(root, "docs/evaluations/harness-quality-code-repair-baseline.json"),
      "utf8",
    ),
  );
  expect(stored.fixtureHash).toBe(baseline.fixtureHash);
  expect(stored.sourceHashes).toEqual(baseline.sourceHashes);
  expect(stored.controls).toEqual(baseline.controls);
  expect(stored.inferenceExecuted).toBe(false);
});
