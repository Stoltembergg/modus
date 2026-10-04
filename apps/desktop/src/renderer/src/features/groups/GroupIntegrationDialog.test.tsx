// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GroupIntegrationPreview,
  GroupIntegrationRecord,
} from "../../../../shared/group-work-state";
import { GroupIntegrationDialog } from "./GroupIntegrationDialog";

function makePreview(id = "preview-1"): GroupIntegrationPreview {
  return {
    id,
    groupId: "g-1",
    taskId: "t-1",
    taskVersion: 2,
    sourceBranch: "group/g-1/parser",
    sourceSha: "a".repeat(40),
    sourceFingerprint: "b".repeat(40),
    targetBranch: "main",
    targetSha: "c".repeat(40),
    targetFingerprint: "d".repeat(40),
    commits: [
      { sha: "a".repeat(40), subject: "Finish parser" },
      { sha: "e".repeat(40), subject: "Add parser fixtures" },
    ],
    omittedCommitCount: 0,
    changedFiles: [{ path: "src/parser.ts", status: "modified" }],
    omittedChangedFileCount: 0,
    diffSummary: "@@ parser @@\n+safe parser output",
    createdAt: "2026-10-03T00:00:00.000Z",
    status: "ready",
  };
}

function makeRecord(
  status: GroupIntegrationRecord["status"],
  preview = makePreview(),
  overrides: Partial<GroupIntegrationRecord> = {},
): GroupIntegrationRecord {
  return {
    id: "integration-1",
    groupId: "g-1",
    taskId: "t-1",
    previewId: preview.id,
    taskVersion: preview.taskVersion,
    sourceBranch: preview.sourceBranch,
    sourceSha: preview.sourceSha,
    targetBranch: preview.targetBranch,
    targetSha: preview.targetSha,
    status,
    version: 1,
    createdAt: preview.createdAt,
    updatedAt: preview.createdAt,
    ...overrides,
  };
}

let getIntegrationState: ReturnType<typeof vi.fn>;
let previewTaskIntegration: ReturnType<typeof vi.fn>;
let applyTaskIntegration: ReturnType<typeof vi.fn>;
let abortTaskIntegration: ReturnType<typeof vi.fn>;
let refreshTaskIntegrationState: ReturnType<typeof vi.fn>;
let listeners: Array<(event: unknown) => void>;

function installGroupApi(state: {
  record?: GroupIntegrationRecord;
  preview?: GroupIntegrationPreview;
}) {
  getIntegrationState = vi.fn(async () => state);
  previewTaskIntegration = vi.fn(async () => makePreview());
  applyTaskIntegration = vi.fn(async () => makeRecord("applied"));
  abortTaskIntegration = vi.fn(async () => makeRecord("aborted"));
  refreshTaskIntegrationState = vi.fn(async () => state);
  listeners = [];
  Object.assign(window, {
    modus: {
      group: {
        getIntegrationState,
        previewTaskIntegration,
        applyTaskIntegration,
        abortTaskIntegration,
        refreshTaskIntegrationState,
        onEvent: vi.fn((listener: (event: unknown) => void) => {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter((item) => item !== listener);
          };
        }),
      },
    },
  });
}

beforeEach(() => installGroupApi({ record: makeRecord("ready"), preview: makePreview() }));
afterEach(() => cleanup());

describe("GroupIntegrationDialog", () => {
  it("shows both branches, bounded commits, changed files, diff, and asks for confirmation", async () => {
    render(<GroupIntegrationDialog groupId="g-1" taskId="t-1" onClose={vi.fn()} />);

    expect(await screen.findByText("group/g-1/parser")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("Finish parser")).toBeTruthy();
    expect(screen.getByText("Add parser fixtures")).toBeTruthy();
    expect(screen.getByText("src/parser.ts")).toBeTruthy();
    expect(screen.getByText(/safe parser output/)).toBeTruthy();
    const apply = screen.getByRole("button", { name: /apply.*merge/i }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(applyTaskIntegration).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("checkbox", { name: /confirm/i }));
    await userEvent.click(apply);
    await waitFor(() =>
      expect(applyTaskIntegration).toHaveBeenCalledWith({
        taskId: "t-1",
        previewId: "preview-1",
        confirmedByUser: true,
      }),
    );
  });

  it("refreshes a stale preview and requires a new confirmation before another apply", async () => {
    const freshPreview = makePreview("preview-2");
    const currentPreview = makePreview();
    getIntegrationState
      .mockResolvedValueOnce({
        record: makeRecord("ready", currentPreview),
        preview: currentPreview,
      })
      .mockResolvedValueOnce({
        record: makeRecord("ready", freshPreview, { version: 2 }),
        preview: freshPreview,
      });
    previewTaskIntegration.mockResolvedValueOnce(freshPreview);
    applyTaskIntegration.mockRejectedValueOnce(
      new Error("[group-error:stale-evidence] The preview is stale."),
    );
    render(<GroupIntegrationDialog groupId="g-1" taskId="t-1" onClose={vi.fn()} />);

    await screen.findByText("group/g-1/parser");
    await userEvent.click(screen.getByRole("checkbox", { name: /confirm/i }));
    await userEvent.click(screen.getByRole("button", { name: /apply.*merge/i }));

    await waitFor(() => expect(previewTaskIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/preview.*stale|changed/i)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /confirm/i }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(applyTaskIntegration).toHaveBeenCalledTimes(1);
    expect(applyTaskIntegration).toHaveBeenCalledWith({
      taskId: "t-1",
      previewId: "preview-1",
      confirmedByUser: true,
    });
    expect(screen.getByRole("button", { name: /apply.*merge/i })).toBeTruthy();
  });

  it("offers a manual retry when refreshing after a stale preview fails", async () => {
    const currentPreview = makePreview();
    const freshPreview = makePreview("preview-retry");
    freshPreview.sourceBranch = "group/g-1/parser-retry";
    const currentRecord = makeRecord("ready", currentPreview);
    const freshRecord = makeRecord("ready", freshPreview, {
      id: "integration-retry",
      version: 1,
    });
    getIntegrationState
      .mockResolvedValueOnce({ record: currentRecord, preview: currentPreview })
      .mockResolvedValueOnce({ record: freshRecord, preview: freshPreview });
    previewTaskIntegration
      .mockRejectedValueOnce(new Error("[group-error:stale-evidence] The source changed."))
      .mockResolvedValueOnce(freshPreview);
    applyTaskIntegration.mockRejectedValueOnce(
      new Error("[group-error:stale-evidence] The preview is stale."),
    );
    render(<GroupIntegrationDialog groupId="g-1" taskId="t-1" onClose={vi.fn()} />);

    expect(await screen.findByText("group/g-1/parser")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: /confirm/i }));
    await userEvent.click(screen.getByRole("button", { name: /apply.*merge/i }));
    await waitFor(() => expect(previewTaskIntegration).toHaveBeenCalledTimes(1));

    await userEvent.click(await screen.findByRole("button", { name: "Refresh preview" }));
    expect(await screen.findByText("group/g-1/parser-retry")).toBeTruthy();
    expect(applyTaskIntegration).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview visible when Git write permission is denied", async () => {
    applyTaskIntegration.mockRejectedValueOnce(
      new Error("[group-error:permission-denied] Git integration was denied."),
    );
    render(<GroupIntegrationDialog groupId="g-1" taskId="t-1" onClose={vi.fn()} />);

    expect((await screen.findAllByText("src/parser.ts")).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("checkbox", { name: /confirm/i }));
    await userEvent.click(screen.getByRole("button", { name: /apply.*merge/i }));

    expect(await screen.findByText(/Allow Git access before applying/)).toBeTruthy();
    expect(screen.getByText("src/parser.ts")).toBeTruthy();
    expect(previewTaskIntegration).not.toHaveBeenCalled();
    expect(applyTaskIntegration).toHaveBeenCalledTimes(1);
  });

  it("shows stored conflict files and requires an explicit abort action", async () => {
    const conflicted = makeRecord("conflict", makePreview(), {
      conflictFiles: ["src/parser.ts", "tests/parser.test.ts"],
    });
    installGroupApi({ record: conflicted, preview: makePreview() });
    render(<GroupIntegrationDialog groupId="g-1" taskId="t-1" onClose={vi.fn()} />);

    expect((await screen.findAllByText("src/parser.ts")).length).toBeGreaterThan(0);
    expect(screen.getByText("tests/parser.test.ts")).toBeTruthy();
    expect(abortTaskIntegration).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /abort.*merge/i }));
    await waitFor(() => expect(abortTaskIntegration).toHaveBeenCalledWith("t-1"));
  });

  it("labels an applied record as a no-commit working-tree change", async () => {
    installGroupApi({ record: makeRecord("applied"), preview: makePreview() });
    render(<GroupIntegrationDialog groupId="g-1" taskId="t-1" onClose={vi.fn()} />);

    expect(await screen.findByText(/no-commit merge/i)).toBeTruthy();
    expect(screen.getAllByText(/working tree/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/delivered|pushed|fully integrated/i)).toBeNull();
    expect(applyTaskIntegration).not.toHaveBeenCalled();
  });

  it("reconciles an applying record only after an explicit status check", async () => {
    const pendingPreview = makePreview();
    const applying = makeRecord("applying", pendingPreview, { version: 2 });
    const recoveredApplied = makeRecord("applied", pendingPreview, { version: 3 });
    installGroupApi({ record: applying, preview: pendingPreview });
    getIntegrationState
      .mockResolvedValueOnce({ record: applying, preview: pendingPreview })
      .mockResolvedValueOnce({ record: recoveredApplied, preview: pendingPreview });
    refreshTaskIntegrationState.mockImplementationOnce(async () => {
      for (const listener of listeners) {
        listener({
          type: "group.integration-changed",
          groupId: "g-1",
          taskId: "t-1",
          record: recoveredApplied,
          version: recoveredApplied.version,
        });
      }
      return { record: recoveredApplied, preview: pendingPreview };
    });
    render(<GroupIntegrationDialog groupId="g-1" taskId="t-1" onClose={vi.fn()} />);

    expect(await screen.findByText("Applying the confirmed integration…")).toBeTruthy();
    expect(previewTaskIntegration).not.toHaveBeenCalled();
    expect(applyTaskIntegration).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Check integration status" }));

    expect(await screen.findByText(/no-commit merge/i)).toBeTruthy();
    expect(refreshTaskIntegrationState).toHaveBeenCalledWith("t-1");
    expect(previewTaskIntegration).not.toHaveBeenCalled();
    expect(applyTaskIntegration).not.toHaveBeenCalled();
  });

  it("lets the user refresh a no-changes preview when the branch advances", async () => {
    const emptyPreview = {
      ...makePreview("preview-empty"),
      commits: [],
      changedFiles: [],
      diffSummary: "No changes to integrate.",
      status: "no_changes" as const,
    };
    const emptyRecord = makeRecord("no_changes", emptyPreview);
    const advancedPreview = makePreview("preview-advanced");
    advancedPreview.sourceBranch = "group/g-1/parser-advanced";
    const advancedRecord = makeRecord("ready", advancedPreview, {
      id: "integration-advanced",
      version: 1,
    });
    installGroupApi({ record: emptyRecord, preview: emptyPreview });
    previewTaskIntegration.mockResolvedValueOnce(advancedPreview);
    getIntegrationState
      .mockResolvedValueOnce({ record: emptyRecord, preview: emptyPreview })
      .mockResolvedValueOnce({ record: advancedRecord, preview: advancedPreview });
    render(<GroupIntegrationDialog groupId="g-1" taskId="t-1" onClose={vi.fn()} />);

    expect(await screen.findByText("This preview contains no changes.")).toBeTruthy();
    expect(applyTaskIntegration).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh preview" }));

    expect(await screen.findByText("group/g-1/parser-advanced")).toBeTruthy();
    expect(previewTaskIntegration).toHaveBeenCalledTimes(1);
    expect(applyTaskIntegration).not.toHaveBeenCalled();
  });

  it("reloads current integration state for newer events and ignores stale versions", async () => {
    const ready = makeRecord("ready", makePreview(), { version: 4 });
    const conflicted = makeRecord("conflict", makePreview(), {
      version: 5,
      conflictFiles: ["src/parser.ts"],
    });
    getIntegrationState
      .mockResolvedValueOnce({ record: ready, preview: makePreview() })
      .mockResolvedValueOnce({ record: conflicted, preview: makePreview() });
    render(<GroupIntegrationDialog groupId="g-1" taskId="t-1" onClose={vi.fn()} />);
    await screen.findByText("group/g-1/parser");

    await act(async () => {
      listeners[0]?.({
        type: "group.integration-changed",
        groupId: "g-1",
        taskId: "t-1",
        record: conflicted,
        version: 5,
      });
      await Promise.resolve();
    });
    expect(await screen.findByText("Resolve or abort this merge conflict")).toBeTruthy();
    await waitFor(() => expect(getIntegrationState).toHaveBeenCalledTimes(2));

    await act(async () => {
      listeners[0]?.({
        type: "group.integration-changed",
        groupId: "g-1",
        taskId: "t-1",
        record: conflicted,
        version: 5,
      });
      listeners[0]?.({
        type: "group.integration-changed",
        groupId: "g-1",
        taskId: "t-1",
        record: ready,
        version: 4,
      });
      await Promise.resolve();
    });
    expect(getIntegrationState).toHaveBeenCalledTimes(2);
  });

  it("accepts a new record at version 1 and ignores delayed events from the previous record", async () => {
    const oldPreview = makePreview("preview-old");
    const oldRecord = makeRecord("applied", oldPreview, {
      id: "integration-old",
      version: 4,
    });
    const oldLateConflict = makeRecord("conflict", oldPreview, {
      id: "integration-old",
      version: 5,
      conflictFiles: ["old/conflict.ts"],
    });
    const newPreview = makePreview("preview-new");
    newPreview.sourceBranch = "group/g-1/parser-retry";
    const newRecord = makeRecord("ready", newPreview, {
      id: "integration-new",
      version: 1,
    });
    getIntegrationState
      .mockResolvedValueOnce({ record: oldRecord, preview: oldPreview })
      .mockResolvedValueOnce({ record: newRecord, preview: newPreview })
      .mockResolvedValueOnce({ record: newRecord, preview: newPreview });
    render(<GroupIntegrationDialog groupId="g-1" taskId="t-1" onClose={vi.fn()} />);

    expect(await screen.findByText(/no-commit merge/i)).toBeTruthy();
    await act(async () => {
      listeners[0]?.({
        type: "group.integration-changed",
        groupId: "g-1",
        taskId: "t-1",
        record: newRecord,
        version: 1,
      });
      await Promise.resolve();
    });

    expect(await screen.findByText("group/g-1/parser-retry")).toBeTruthy();
    expect(
      screen.queryByText(
        "Changes are in the working tree as a no-commit merge. Complete the merge in Git.",
      ),
    ).toBeNull();
    await act(async () => {
      listeners[0]?.({
        type: "group.integration-changed",
        groupId: "g-1",
        taskId: "t-1",
        record: oldLateConflict,
        version: 5,
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(getIntegrationState).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("Resolve or abort this merge conflict")).toBeNull();
    expect(screen.getByText("Preview ready. Confirm before applying.")).toBeTruthy();
  });
});
