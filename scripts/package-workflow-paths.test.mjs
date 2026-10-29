import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflowRoot = new URL("../.github/workflows/", import.meta.url);
const workflows = new Map([
  ["mac", readFileSync(new URL("package-mac.yml", workflowRoot), "utf8")],
  ["windows", readFileSync(new URL("package-win.yml", workflowRoot), "utf8")],
  ["linux", readFileSync(new URL("release.yml", workflowRoot), "utf8")],
]);

function pullRequestPathPatterns(source) {
  const pullRequestIndex = source.indexOf("\n  pull_request:\n");
  assert.notEqual(pullRequestIndex, -1, "workflow must define a pull_request trigger");
  const afterPullRequest = source.slice(pullRequestIndex);
  const pathsIndex = afterPullRequest.indexOf("\n    paths:\n");
  assert.notEqual(pathsIndex, -1, "pull_request must have explicit path filters");
  const pathLines = afterPullRequest.slice(pathsIndex).split(/\r?\n/).slice(1);
  const patterns = [];
  for (const line of pathLines) {
    const match = line.match(/^\s+- "([^"]+)"$/);
    if (match) {
      patterns.push(match[1]);
      continue;
    }
    if (patterns.length > 0 && line.trim() !== "") break;
  }
  assert.ok(patterns.length > 0, "pull_request path filter must not be empty");
  return patterns;
}

function matches(pattern, filePath) {
  if (pattern.endsWith("/**")) return filePath.startsWith(pattern.slice(0, -2));
  return pattern === filePath;
}

function triggeredWorkflows(filePath) {
  return [...workflows].flatMap(([name, source]) =>
    pullRequestPathPatterns(source).some((pattern) => matches(pattern, filePath)) ? [name] : [],
  );
}

test("package inputs trigger macOS, Windows and Linux dry-run packaging", () => {
  for (const changedPath of [
    "package.json",
    "package-lock.json",
    ".npmrc",
    "Cargo.toml",
    "Cargo.lock",
    "apps/desktop/electron-builder.config.ts",
    "apps/desktop/resources/icon.png",
    "apps/desktop/scripts/build-plugin-supervisor.mjs",
    "crates/modus-rea-process-supervisor/Cargo.toml",
    "crates/pty-host/src/main.rs",
  ]) {
    assert.deepEqual(
      triggeredWorkflows(changedPath).sort(),
      ["linux", "mac", "windows"],
      `${changedPath} must run each platform packaging dry run`,
    );
  }
});

test("documentation-only changes do not run platform package builds", () => {
  assert.deepEqual(triggeredWorkflows("docs/releasing.md"), []);
  assert.deepEqual(triggeredWorkflows("apps/desktop-old/package.json"), []);
});

test("release publication remains tag-only while Linux PR packaging stays read-only", () => {
  const source = workflows.get("linux");
  assert.match(source, /push:\n\s+tags:\s*\["v\*"\]/);
  assert.match(source, /permissions:\n\s+contents: read/);
  assert.match(source, /draft-release:[\s\S]*?if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(source, /publish-assets:[\s\S]*?if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

test("macOS package dry runs verify the ad-hoc signed app and downloaded zip payload", () => {
  const source = workflows.get("mac");
  assert.match(source, /CSC_FOR_PULL_REQUEST: "true"/);
  assert.match(source, /codesign --verify --deep --strict/);
  assert.match(source, /ditto -x -k/);
  assert.match(source, /verify "apps\/desktop\/dist\/\$APP_DIR\/Modus\.app"/);
  assert.match(source, /verify "\$unzipped\/Modus\.app"/);
  assert.doesNotMatch(source, /CSC_LINK:|CSC_KEY_PASSWORD:/);
});
