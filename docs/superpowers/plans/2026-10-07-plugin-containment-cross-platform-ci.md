# Plugin Containment Cross-Platform CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the focused Pi SDK and Modus plugin containment regressions on Windows, macOS and Linux before considering this containment tranche complete.

**Architecture:** Add a separate GitHub Actions matrix job so the existing full Ubuntu check remains unchanged. The matrix installs the same Node version as current CI and runs the dedicated Pi extension containment sentinel, only the `restrictive extension loader` and plugin-bootstrap/startup-sync ordering regressions from the Pi runtime file, and the plugin/capability suites; it validates the fail-closed gate, not a future OS sandbox.

**Tech Stack:** GitHub Actions, Node.js 24.21.0, npm workspaces, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-plugin-loading-containment-design.md`

## Global Constraints

- Block temporarily `community`, `local` and any source without trust issued by the host.
- Keep the block on Windows, macOS and Linux until equivalent isolation and adversarial validation exist on each platform.
- Future third-party extensions use an API without Node and with explicit capabilities.
- Prioritize isolation over the in-process `<0,2 ms` SLO.
- **AUTHORIZATION BEFORE RESOLUTION:** no external path/module specifier is resolved before the gate.
- **AUTHORIZATION BEFORE IMPORT:** no external `import()`/`require()`/factory runs before the gate.
- **TRUST IS NOT SERIALIZABLE AUTHORITY:** SQLite/settings/manifest trust does not authorize code.
- **DENIED MEANS ZERO SIDE EFFECT:** a denied plugin runs no top-level code, hook, provider constructor or migration.
- Passing this job validates only containment parity; it does not close A01–A04 or authorize hostile extensions.

---

### Task 1: Add a focused three-platform containment matrix

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Pi sentinel test `apps/desktop/src/main/agent/pi-sdk-extension-containment.test.ts`, only the `restrictive extension loader` test in `apps/desktop/src/main/agent/pi-sdk-runtime.test.ts`, plugin directory `apps/desktop/src/main/agent/harness/plugin`, and capability registry test `apps/desktop/src/main/agent/harness/capability/capability-registry.test.ts`.
- Produces: Dedicated `plugin-containment` matrix job with Ubuntu, Windows and macOS runners.
- Dependency: Execute after the Pi SDK and Modus plugin containment plans add their tests.

- [ ] **Step 1: Add the matrix job without changing the existing Ubuntu full-suite job**

Add a `plugin-containment` job with `fail-fast: false`, `runs-on: ${{ matrix.os }}`, and `matrix.os: [ubuntu-latest, windows-latest, macos-latest]`. Match existing CI by using `actions/checkout@v7`, `actions/setup-node@v7`, Node `24.21.0`, npm cache and `npm ci`.

- [ ] **Step 2: Run the focused tests serially on each runner**

Run these as separate commands/steps in the matrix job so the runtime test-name filter cannot exclude tests in the other files:

```sh
npx vitest run --root . --no-file-parallelism --maxWorkers=1 --testTimeout=20000 apps/desktop/src/main/agent/pi-sdk-extension-containment.test.ts
npx vitest run --root . --no-file-parallelism --maxWorkers=1 --testTimeout=20000 apps/desktop/src/main/agent/pi-sdk-runtime.test.ts -t "restrictive extension loader"
npx vitest run --root . --no-file-parallelism --maxWorkers=1 --testTimeout=20000 apps/desktop/src/main/agent/pi-sdk-runtime.test.ts -t "waits for plugin bootstrap to settle before startup lifecycle sync"
npx vitest run --root . --no-file-parallelism --maxWorkers=1 --testTimeout=20000 apps/desktop/src/main/agent/harness/plugin apps/desktop/src/main/agent/harness/capability/capability-registry.test.ts
```

Set the job timeout to 30 minutes. Do not make the job `continue-on-error`; an OS-specific regression must fail the check.

The broad `pi-sdk-runtime.test.ts` suite is intentionally excluded: its full run currently has seven failures that have not been attributed to a baseline: QA evidence statuses are missing versus expected, task verification is `unknown` versus `verified`, a response policy directive is absent, and observer metrics/evaluation are absent. Do not describe these failures as baseline. The focused Windows run does not prove macOS or Linux behavior; only the matrix results provide cross-platform evidence.

- [ ] **Step 3: Validate the focused command locally on Windows**

Run the three focused Vitest commands from the repository root on the local Windows environment.

Expected: PASS for the selected focused scope. A local Windows pass is not proof of macOS/Linux behavior.

- [ ] **Step 4: Review the workflow diff without staging unrelated changes**

Run `git status --short` and inspect the new matrix job. Leave it uncommitted pending user review.

### Task 2: Confirm the GitHub Actions matrix is the release gate

**Files:**
- Verify: `.github/workflows/ci.yml`
- Verify: the three containment plan test paths listed above

**Interfaces:**
- Consumes: The completed Pi and Modus containment test changes from the two preceding plans.
- Produces: CI evidence from all three OS runners; local Windows execution alone is not reported as cross-platform proof. Treat green results as the containment acceptance gate; do not claim A01–A04 closure.

- [ ] **Step 1: Open a PR or run the workflow on the branch**

Wait for the `plugin-containment (ubuntu-latest)`, `plugin-containment (windows-latest)`, and `plugin-containment (macos-latest)` jobs to finish.

- [ ] **Step 2: Record all three results**

Expected: all three matrix jobs pass. If a runner fails, fix or explain the platform-specific behavior and rerun; do not mark the tranche validated while a matrix leg is red.

- [ ] **Step 3: Preserve the audit gate**

Keep the release decision **NO-GO for hostile extensions** after this plan. Record that A01–A04 remain open until the separate isolated-executor tranche is designed and proven.
