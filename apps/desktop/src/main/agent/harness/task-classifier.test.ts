import { describe, expect, it } from "vitest";
import { classifyHarnessTask } from "./task-classifier";

const input = (overrides: Partial<Parameters<typeof classifyHarnessTask>[0]> = {}) => ({
  text: "",
  mode: "build" as const,
  contextPaths: [],
  changedPaths: [],
  ...overrides,
});

describe("classifyHarnessTask", () => {
  it("keeps clear one-file implementation work simple and inline", () => {
    expect(
      classifyHarnessTask(
        input({ text: "Fix the typo in the button label", changedPaths: ["src/Button.tsx"] }),
      ),
    ).toEqual({
      taskType: "implementation",
      complexity: "simple",
      risk: "low",
      confidence: "high",
      reasons: ["clear_implementation_request", "single_file_change"],
    });
  });

  it.each([
    ["Find where the settings screen handles keyboard shortcuts", "explore", "explore"],
    ["Research the latest React Router documentation", "librarian", "librarian"],
    ["Evaluate the architecture for splitting the runtime", "oracle", "oracle"],
    ["Review this diff for regressions", "reviewer", "reviewer"],
    ["Debug why the request times out", "debugger", "debugger"],
    ["Improve the visual hierarchy and spacing of the settings panel", "ui-ux", "ui-ux"],
  ] as const)("classifies %s as %s", (text, taskType, suggestedRole) => {
    expect(classifyHarnessTask(input({ text }))).toMatchObject({
      taskType,
      confidence: "high",
      suggestedRole,
    });
  });

  it.each([
    "Review and fix the retry behavior",
    "Fix the UI layout regression",
  ])("does not route mixed specialist and implementation intent: %s", (text) => {
    expect(classifyHarnessTask(input({ text }))).toMatchObject({
      taskType: "unknown",
      confidence: "low",
    });
    expect(classifyHarnessTask(input({ text }))).not.toHaveProperty("suggestedRole");
  });

  it("classifies related multi-file work as moderate", () => {
    expect(
      classifyHarnessTask(
        input({
          text: "Update the settings validation and its tests",
          changedPaths: ["src/settings/form.ts", "src/settings/form.test.ts"],
        }),
      ),
    ).toMatchObject({ complexity: "moderate", risk: "low", confidence: "high" });
  });

  it("classifies cross-subsystem work as complex", () => {
    expect(
      classifyHarnessTask(
        input({
          text: "Implement coordinated account sync across authentication and persistence",
          contextPaths: ["src/auth/session.ts", "src/db/accounts.ts", "src/sync/worker.ts"],
          changedPaths: ["src/auth/session.ts", "src/db/accounts.ts", "src/sync/worker.ts"],
        }),
      ),
    ).toMatchObject({ complexity: "complex", confidence: "high" });
  });

  it("recognizes repository-rooted paths from distinct desktop subsystems as complex", () => {
    expect(
      classifyHarnessTask(
        input({
          text: "Implement coordinated desktop behavior across main and renderer",
          changedPaths: [
            "apps/desktop/src/main/agent/runtime.ts",
            "apps/desktop/src/main/agent/tools/task.ts",
            "apps/desktop/src/renderer/src/features/agent/ChatPane.tsx",
          ],
        }),
      ),
    ).toMatchObject({
      complexity: "complex",
      reasons: expect.arrayContaining(["cross_subsystem_scope"]),
    });
  });

  it.each([
    "Migrate the production database schema",
    "Fix the authentication security vulnerability",
    "Remove all generated user data",
  ])("classifies risky signal %s as high risk", (text) => {
    expect(classifyHarnessTask(input({ text }))).toMatchObject({ risk: "high" });
  });

  it("classifies the explicit destructive-action flag as high risk", () => {
    expect(
      classifyHarnessTask(input({ text: "Make a change", hasDestructiveAction: true })),
    ).toMatchObject({
      risk: "high",
    });
  });

  it("returns unknown with low confidence for an uninformative prompt", () => {
    expect(classifyHarnessTask(input({ text: "Help" }))).toMatchObject({
      taskType: "unknown",
      complexity: "simple",
      confidence: "low",
      reasons: ["insufficient_task_signal"],
    });
  });

  it("returns stable, de-duplicated reason codes", () => {
    const task = input({
      text: "Review and debug the security issue in this migration",
      changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      hasDestructiveAction: true,
    });
    expect(classifyHarnessTask(task)).toEqual(classifyHarnessTask(task));
    expect(classifyHarnessTask(task).reasons).toEqual([
      "review_request",
      "debug_request",
      "security_signal",
      "migration_signal",
      "destructive_action",
      "cross_subsystem_scope",
      "multiple_files_changed",
    ]);
  });
});
