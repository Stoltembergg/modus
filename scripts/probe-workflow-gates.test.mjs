import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workflowDirectory = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const authorizedWorkflows = new Map([
  ["plugin-sandbox-probe-linux.yml", "RUN_LINUX_PROBE"],
  ["plugin-sandbox-probe-windows.yml", "RUN_WINDOWS_PROBE"],
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
  assert.deepEqual(topLevelKeys(triggerLines), ["workflow_dispatch"], `${fileName} must only trigger manually`);
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
      jobText.includes(`if: github.event_name == 'workflow_dispatch' && inputs.authorization == '${token}'`),
      `${fileName} job ${job.name} must require manual dispatch and ${token}`,
    );
  }
}

test("Linux and Windows probe workflows require manual dispatch and explicit authorization", () => {
  for (const [fileName, token] of authorizedWorkflows) {
    const source = readFileSync(`${workflowDirectory}/${fileName}`, "utf8");
    assertManualAuthorization(source, token, fileName);
  }
});

test("probe and worker commands stay inside the manually authorized workflows", () => {
  const workflowFiles = readdirSync(workflowDirectory).filter((fileName) => /\.ya?ml$/.test(fileName));
  const executionMarkers = /plugin-sandbox-probe|--probe\b|--worker\b/i;
  const executionWorkflows = workflowFiles.filter((fileName) =>
    executionMarkers.test(readFileSync(`${workflowDirectory}/${fileName}`, "utf8")),
  );

  assert.deepEqual(
    executionWorkflows.sort(),
    [...authorizedWorkflows.keys()].sort(),
    "probe/worker references must not be added to automatically triggered workflows",
  );
});
