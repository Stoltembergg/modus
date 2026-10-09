// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanRef } from "../../../../shared/contracts";
import { PlanPanel } from "./PlanPanel";

const plan: PlanRef = {
  id: "plan-1",
  title: "Account security",
  overview: "Protect account access.",
  path: "/workspace/plan.md",
  hash: "hash-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  blocks: [{ type: "markdown", content: "# Keep the plan readable" }],
  content: "# Keep the plan readable",
  todos: [],
  spec: {
    requirements: [{ id: "req-1", text: "Protect account access" }],
    acceptanceCriteria: [
      {
        id: "criterion-1",
        requirementId: "req-1",
        description: "Reject invalid credentials",
        todoIds: [],
        status: "pending",
      },
    ],
    evidence: [],
    assumptions: [],
    openQuestions: [],
  },
  buildStatus: "not_built",
  createdAt: "now",
  updatedAt: "now",
};

describe("PlanPanel", () => {
  it("keeps the Markdown plan and adds Spec acceptance details", () => {
    const markup = renderToStaticMarkup(<PlanPanel plan={plan} />);

    expect(markup).toContain("Keep the plan readable");
    expect(markup).toContain("Acceptance criteria");
    expect(markup).toContain("Reject invalid credentials");
  });

  it("revalidates persisted QA against the current source revision", async () => {
    const runWorkspaceRevision = vi.fn().mockResolvedValue("rev-current");
    const originalModus = Object.getOwnPropertyDescriptor(window, "modus");
    const spec = plan.spec;
    if (!spec) throw new Error("Test plan requires a Spec.");
    const criterion = spec.acceptanceCriteria[0];
    if (!criterion) throw new Error("Test plan requires an acceptance criterion.");
    const passedPlan: PlanRef = {
      ...plan,
      spec: {
        ...spec,
        acceptanceCriteria: [
          {
            ...criterion,
            requiredCheckKinds: ["tests"],
            status: "passed",
          },
        ],
        evidence: [
          {
            id: "evidence-tests",
            criterionId: "criterion-1",
            kind: "check",
            status: "passed",
            runId: "run-qa",
            eventId: "event-qa",
            revision: "rev-verified",
            label: "Tests",
          },
        ],
      },
    };
    Object.defineProperty(window, "modus", {
      configurable: true,
      value: {
        app: { platform: "linux" },
        agent: { runWorkspaceRevision },
        files: {
          watch: vi.fn(async (cwd: string) => cwd),
          isWatching: vi.fn(async () => true),
          unwatch: vi.fn(async () => undefined),
          onChanged: vi.fn(() => () => undefined),
        },
      },
    });

    try {
      render(<PlanPanel sessionCwd="/workspace" plan={passedPlan} />);

      await waitFor(() => {
        expect(runWorkspaceRevision).toHaveBeenCalledWith({
          sessionId: passedPlan.sessionId,
          runId: "run-qa",
        });
        expect(screen.getByText("Not verified")).toBeTruthy();
      });
    } finally {
      cleanup();
      if (originalModus) Object.defineProperty(window, "modus", originalModus);
      else Reflect.deleteProperty(window, "modus");
    }
  });

  it("removes a displayed QA pass after the watched workspace changes", async () => {
    const runWorkspaceRevision = vi.fn().mockResolvedValue("rev-verified");
    const originalModus = Object.getOwnPropertyDescriptor(window, "modus");
    const spec = plan.spec;
    if (!spec) throw new Error("Test plan requires a Spec.");
    const criterion = spec.acceptanceCriteria[0];
    if (!criterion) throw new Error("Test plan requires an acceptance criterion.");
    let onChanged:
      | ((event: { cwd: string; paths: string[]; watching?: boolean }) => void)
      | undefined;
    const passedPlan: PlanRef = {
      ...plan,
      spec: {
        ...spec,
        acceptanceCriteria: [{ ...criterion, requiredCheckKinds: ["tests"], status: "passed" }],
        evidence: [
          {
            id: "evidence-tests",
            criterionId: "criterion-1",
            kind: "check",
            status: "passed",
            runId: "run-qa",
            eventId: "event-qa",
            revision: "rev-verified",
            label: "Tests",
          },
        ],
      },
    };
    Object.defineProperty(window, "modus", {
      configurable: true,
      value: {
        app: { platform: "linux" },
        agent: { runWorkspaceRevision },
        files: {
          watch: vi.fn(async (cwd: string) => cwd),
          isWatching: vi.fn(async () => true),
          unwatch: vi.fn(async () => undefined),
          onChanged: vi.fn((listener: typeof onChanged) => {
            onChanged = listener;
            return () => {
              onChanged = undefined;
            };
          }),
        },
      },
    });

    try {
      render(<PlanPanel plan={passedPlan} sessionCwd="/workspace" />);

      await waitFor(() => expect(screen.getByText("Passed")).toBeTruthy());
      expect(onChanged).toBeDefined();
      runWorkspaceRevision.mockResolvedValue("rev-current");
      await act(async () => {
        onChanged?.({ cwd: "/workspace", paths: [] });
      });

      await waitFor(() => expect(screen.getByText("Not verified")).toBeTruthy());
    } finally {
      cleanup();
      if (originalModus) Object.defineProperty(window, "modus", originalModus);
      else Reflect.deleteProperty(window, "modus");
    }
  });

  it("revalidates persisted QA when filesystem notifications do not arrive", async () => {
    vi.useFakeTimers();
    const runWorkspaceRevision = vi
      .fn()
      .mockResolvedValueOnce("rev-verified")
      .mockResolvedValue("rev-current");
    const originalModus = Object.getOwnPropertyDescriptor(window, "modus");
    const spec = plan.spec;
    if (!spec) throw new Error("Test plan requires a Spec.");
    const criterion = spec.acceptanceCriteria[0];
    if (!criterion) throw new Error("Test plan requires an acceptance criterion.");
    const passedPlan: PlanRef = {
      ...plan,
      spec: {
        ...spec,
        acceptanceCriteria: [{ ...criterion, requiredCheckKinds: ["tests"], status: "passed" }],
        evidence: [
          {
            id: "evidence-tests",
            criterionId: "criterion-1",
            kind: "check",
            status: "passed",
            runId: "run-qa",
            eventId: "event-qa",
            revision: "rev-verified",
            label: "Tests",
          },
        ],
      },
    };
    Object.defineProperty(window, "modus", {
      configurable: true,
      value: {
        app: { platform: "linux" },
        agent: { runWorkspaceRevision },
        files: {
          watch: vi.fn(async (cwd: string) => cwd),
          isWatching: vi.fn(async () => true),
          unwatch: vi.fn(async () => undefined),
          onChanged: vi.fn(() => () => undefined),
        },
      },
    });

    try {
      render(<PlanPanel plan={passedPlan} sessionCwd="/workspace" />);
      await act(async () => {
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      expect(screen.getByText("Passed")).toBeTruthy();
      expect(runWorkspaceRevision).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(runWorkspaceRevision).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Not verified")).toBeTruthy();
    } finally {
      cleanup();
      vi.useRealTimers();
      if (originalModus) Object.defineProperty(window, "modus", originalModus);
      else Reflect.deleteProperty(window, "modus");
    }
  });

  it("does not present persisted QA as passed when live workspace watching is unavailable", async () => {
    const runWorkspaceRevision = vi.fn().mockResolvedValue("rev-verified");
    const originalModus = Object.getOwnPropertyDescriptor(window, "modus");
    const spec = plan.spec;
    if (!spec) throw new Error("Test plan requires a Spec.");
    const criterion = spec.acceptanceCriteria[0];
    if (!criterion) throw new Error("Test plan requires an acceptance criterion.");
    let onChanged:
      | ((event: { cwd: string; paths: string[]; watching?: boolean }) => void)
      | undefined;
    const passedPlan: PlanRef = {
      ...plan,
      spec: {
        ...spec,
        acceptanceCriteria: [{ ...criterion, requiredCheckKinds: ["tests"], status: "passed" }],
        evidence: [
          {
            id: "evidence-tests",
            criterionId: "criterion-1",
            kind: "check",
            status: "passed",
            runId: "run-qa",
            eventId: "event-qa",
            revision: "rev-verified",
            label: "Tests",
          },
        ],
      },
    };
    Object.defineProperty(window, "modus", {
      configurable: true,
      value: {
        app: { platform: "linux" },
        agent: { runWorkspaceRevision },
        files: {
          watch: vi.fn(async (cwd: string) => cwd),
          isWatching: vi.fn(async () => true),
          unwatch: vi.fn(async () => undefined),
          onChanged: vi.fn((listener: typeof onChanged) => {
            onChanged = listener;
            return () => {
              onChanged = undefined;
            };
          }),
        },
      },
    });

    try {
      render(<PlanPanel plan={passedPlan} sessionCwd="/workspace" />);
      await waitFor(() => expect(screen.getByText("Passed")).toBeTruthy());
      expect(onChanged).toBeDefined();
      await act(async () => {
        onChanged?.({ cwd: "/unrelated-workspace", paths: [], watching: false });
      });
      expect(screen.getByText("Passed")).toBeTruthy();
      await act(async () => {
        onChanged?.({ cwd: "/workspace", paths: [], watching: false });
      });
      expect(screen.getByText("Not verified")).toBeTruthy();
      expect(runWorkspaceRevision).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      if (originalModus) Object.defineProperty(window, "modus", originalModus);
      else Reflect.deleteProperty(window, "modus");
    }
  });

  it("does not query or display QA when the workspace watcher is unavailable at startup", async () => {
    const runWorkspaceRevision = vi.fn().mockResolvedValue("rev-verified");
    const originalModus = Object.getOwnPropertyDescriptor(window, "modus");
    const spec = plan.spec;
    if (!spec) throw new Error("Test plan requires a Spec.");
    const criterion = spec.acceptanceCriteria[0];
    if (!criterion) throw new Error("Test plan requires an acceptance criterion.");
    const passedPlan: PlanRef = {
      ...plan,
      spec: {
        ...spec,
        acceptanceCriteria: [{ ...criterion, requiredCheckKinds: ["tests"], status: "passed" }],
        evidence: [
          {
            id: "evidence-tests",
            criterionId: "criterion-1",
            kind: "check",
            status: "passed",
            runId: "run-qa",
            eventId: "event-qa",
            revision: "rev-verified",
            label: "Tests",
          },
        ],
      },
    };
    Object.defineProperty(window, "modus", {
      configurable: true,
      value: {
        app: { platform: "linux" },
        agent: { runWorkspaceRevision },
        files: {
          watch: vi.fn(async (cwd: string) => cwd),
          isWatching: vi.fn(async () => false),
          unwatch: vi.fn(async () => undefined),
          onChanged: vi.fn(() => () => undefined),
        },
      },
    });

    try {
      render(<PlanPanel plan={passedPlan} sessionCwd="/workspace" />);
      expect(screen.getByText("Not verified")).toBeTruthy();
      await waitFor(() => {
        expect(window.modus.files.isWatching).toHaveBeenCalledWith("/workspace");
      });
      expect(runWorkspaceRevision).not.toHaveBeenCalled();
    } finally {
      cleanup();
      if (originalModus) Object.defineProperty(window, "modus", originalModus);
      else Reflect.deleteProperty(window, "modus");
    }
  });
});
