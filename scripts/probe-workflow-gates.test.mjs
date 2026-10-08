import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workflowDirectory = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const authorizedWorkflows = new Map([
  ["plugin-sandbox-probe-linux.yml", "RUN_LINUX_PROBE"],
  ["plugin-sandbox-probe-windows.yml", "RUN_WINDOWS_PROBE"],
  ["plugin-security-scenarios.yml", "RUN_PLUGIN_SECURITY_SCENARIOS"],
]);

function topLevelSection(source, sectionName) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${sectionName}:`);
  assert.notEqual(start, -1, `missing top-level ${sectionName}: section`);

  const end = lines.findIndex(
    (line, index) => index > start && /^[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(line),
  );
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function topLevelKeys(sectionLines) {
  return sectionLines.flatMap((line) => {
    const match = line.match(/^  ([A-Za-z][A-Za-z0-9_-]*):\s*$/);
    return match ? [match[1]] : [];
  });
}

function assertManualAuthorization(source, token, fileName) {
  const triggerLines = topLevelSection(source, "on");
  assert.deepEqual(
    topLevelKeys(triggerLines),
    ["workflow_dispatch"],
    `${fileName} must only trigger manually`,
  );
  assert.match(
    triggerLines.join("\n"),
    /^  workflow_dispatch:\n    inputs:\n      authorization:\n        description: .+\n        required: true\n        type: string$/m,
    `${fileName} must require an explicit authorization input`,
  );

  const jobLines = topLevelSection(source, "jobs");
  const jobHeaders = jobLines.flatMap((line, index) => {
    const match = line.match(/^  ([a-z][a-z0-9_-]*):\s*$/);
    return match ? [{ index, name: match[1] }] : [];
  });
  assert.ok(jobHeaders.length > 0, `${fileName} must define a job`);

  for (const [index, job] of jobHeaders.entries()) {
    const end = jobHeaders[index + 1]?.index ?? jobLines.length;
    const jobText = jobLines.slice(job.index, end).join("\n");
    assert.ok(
      jobText.includes(
        `if: github.event_name == 'workflow_dispatch' && inputs.authorization == '${token}'`,
      ),
      `${fileName} job ${job.name} must require manual dispatch and ${token}`,
    );
  }
}

test("sensitive probe and scenario workflows require manual dispatch and explicit authorization", () => {
  for (const [fileName, token] of authorizedWorkflows) {
    const source = readFileSync(`${workflowDirectory}/${fileName}`, "utf8");
    assertManualAuthorization(source, token, fileName);
  }
});

test("probe and worker commands stay inside the manually authorized workflows", () => {
  const workflowFiles = readdirSync(workflowDirectory).filter((fileName) =>
    /\.ya?ml$/.test(fileName),
  );
  const safeCiCompileCommands = [
    "run: cargo fmt --manifest-path crates/plugin-sandbox-probe/Cargo.toml -- --check",
    "run: cargo check --locked -p plugin-sandbox-probe --all-targets",
  ];
  const manualScenarioNames =
    "adversarial bypass hardening|enforces timeout for hanging or infinite-looping community plugins|throws WasmFuelExhaustedError and cleanly interrupts infinite/runaway loop|captures fuel exhaustion gracefully in executeWasm without crashing host";

  for (const fileName of workflowFiles) {
    if (authorizedWorkflows.has(fileName)) continue;

    const source = readFileSync(`${workflowDirectory}/${fileName}`, "utf8");
    const referenceLines = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /plugin-sandbox-probe|--probe\b|--worker\b/i.test(line));

    if (fileName === "ci.yml") {
      assert.deepEqual(
        referenceLines,
        safeCiCompileCommands,
        "automatic CI may only format and compile the sandbox probe crate",
      );
      continue;
    }

    assert.deepEqual(
      referenceLines,
      [],
      `${fileName} must not reference probes or workers without a manual authorization gate`,
    );
  }

  const ciSource = readFileSync(`${workflowDirectory}/ci.yml`, "utf8");
  const safeScenarioPattern = `^(?!.*(?:${manualScenarioNames}))`;
  const automaticVitestCommands = ciSource
    .split(/\r?\n/)
    .filter((line) => /npm run test(?:\s|$)|npx vitest run/.test(line));
  const automaticScenarioCommands = automaticVitestCommands.filter(
    (line) =>
      /npm run test(?:\s|$)/.test(line) ||
      (/npx vitest run/.test(line) &&
        /apps\/desktop\/src\/main\/agent\/harness\/plugin(?:\s|\/)/.test(line)),
  );

  assert.equal(
    automaticScenarioCommands.length,
    2,
    "automatic CI must have exactly the root and plugin Vitest suites under review",
  );
  assert.ok(
    automaticScenarioCommands.every((line) =>
      line.includes(`--testNamePattern='${safeScenarioPattern}'`),
    ),
    "root and plugin Vitest suites must exclude manually authorized security scenarios",
  );

  const manualScenarioSource = readFileSync(
    `${workflowDirectory}/plugin-security-scenarios.yml`,
    "utf8",
  );
  assert.ok(
    manualScenarioSource.includes(`--testNamePattern='(${manualScenarioNames})'`),
    "the manual scenario workflow must select the excluded security cases",
  );
});
