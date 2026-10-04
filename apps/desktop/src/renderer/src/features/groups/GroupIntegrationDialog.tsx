import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupRuntimeEvent } from "../../../../shared/contracts";
import { decodeGroupErrorMessage } from "../../../../shared/group-errors";
import type {
  GroupIntegrationPreview,
  GroupIntegrationRecord,
  GroupIntegrationState,
} from "../../../../shared/group-work-state";
import { describeGroupError } from "./groupErrors";

type Props = {
  groupId: string;
  taskId: string;
  onClose(): void;
};

export function GroupIntegrationDialog({ groupId, taskId, onClose }: Props) {
  const [state, setState] = useState<GroupIntegrationState>({});
  const [preview, setPreview] = useState<GroupIntegrationPreview>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  const highestVersion = useRef(0);
  const highestRecordId = useRef<string | undefined>(undefined);
  const reloadSequence = useRef(0);

  const acceptState = useCallback(
    (next: GroupIntegrationState, minimumVersion = 0, minimumRecordId?: string): boolean => {
      const record = next.record;
      const version = record?.version ?? 0;
      if (record?.id === highestRecordId.current && version < highestVersion.current) return false;
      if (record && minimumRecordId === record.id && version < minimumVersion) return false;
      highestRecordId.current = record?.id;
      highestVersion.current = version;
      setState(next);
      setPreview((current) => {
        if (next.preview) return next.preview;
        return next.record?.previewId === current?.id ? current : undefined;
      });
      return true;
    },
    [],
  );

  const reloadState = useCallback(
    async (
      minimumVersion = 0,
      minimumRecordId?: string,
    ): Promise<GroupIntegrationState | undefined> => {
      const requestId = ++reloadSequence.current;
      const next = await window.modus.group.getIntegrationState(taskId);
      if (requestId !== reloadSequence.current) return undefined;
      if (!acceptState(next, minimumVersion, minimumRecordId)) return undefined;
      return next;
    },
    [acceptState, taskId],
  );

  const requestPreview = useCallback(
    async (preserveError = false): Promise<void> => {
      setLoading(true);
      setConfirmed(false);
      if (!preserveError) setError(undefined);
      try {
        const nextPreview = await window.modus.group.previewTaskIntegration(taskId);
        setPreview(nextPreview);
        const persisted = await reloadState();
        if (!persisted) return;
        if (!persisted.record) {
          setState({ preview: nextPreview });
        } else if (persisted.preview?.id !== nextPreview.id) {
          setPreview(persisted.preview);
        }
      } catch (cause) {
        setError(describeGroupError(cause));
      } finally {
        setLoading(false);
      }
    },
    [reloadState, taskId],
  );

  useEffect(() => {
    let disposed = false;
    async function load(): Promise<void> {
      setLoading(true);
      try {
        const requestId = reloadSequence.current;
        const saved = await window.modus.group.getIntegrationState(taskId);
        if (disposed || requestId !== reloadSequence.current) return;
        acceptState(saved);
        if (!saved.record) {
          await requestPreview();
        } else if (
          saved.record.status === "ready" &&
          (!saved.preview || saved.preview.id !== saved.record.previewId)
        ) {
          await requestPreview();
        }
      } catch (cause) {
        if (!disposed) setError(describeGroupError(cause));
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void load();
    const unsubscribe = window.modus.group.onEvent((event: GroupRuntimeEvent) => {
      if (
        event.type !== "group.integration-changed" ||
        event.groupId !== groupId ||
        event.taskId !== taskId ||
        (event.record.id === highestRecordId.current && event.version <= highestVersion.current)
      ) {
        return;
      }
      void reloadState(event.version, event.record.id).catch((cause: unknown) =>
        setError(describeGroupError(cause)),
      );
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [acceptState, groupId, reloadState, requestPreview, taskId]);

  async function apply(): Promise<void> {
    if (!preview || !confirmed || busy || state.record?.status === "no_changes") return;
    setBusy(true);
    setConfirmed(false);
    setError(undefined);
    try {
      const record = await window.modus.group.applyTaskIntegration({
        taskId,
        previewId: preview.id,
        confirmedByUser: true,
      });
      await reloadState(record.version, record.id);
    } catch (cause) {
      const { code } = decodeGroupErrorMessage(cause);
      setError(describeGroupError(cause));
      if (code === "stale-task" || code === "stale-evidence") {
        setPreview(undefined);
        setConfirmed(false);
        await requestPreview(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function abort(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const record = await window.modus.group.abortTaskIntegration(taskId);
      await reloadState(record.version, record.id);
    } catch (cause) {
      setError(describeGroupError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function checkIntegrationStatus(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setLoading(true);
    setError(undefined);
    const requestId = ++reloadSequence.current;
    try {
      const latest = await window.modus.group.refreshTaskIntegrationState(taskId);
      if (requestId === reloadSequence.current) acceptState(latest);
    } catch (cause) {
      setError(describeGroupError(cause));
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }

  const record = state.record;
  const ready = record?.status === "ready" && preview?.status === "ready";
  const noChanges = record?.status === "no_changes" || preview?.status === "no_changes";

  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Popup
          className="surface-panel fixed inset-4 z-50 mx-auto flex max-h-[calc(100vh-2rem)] w-[min(672px,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-hairline shadow-xl outline-none"
          initialFocus
        >
          <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
            <Dialog.Title className="font-medium text-fg">Integrate task</Dialog.Title>
            <button onClick={onClose} type="button">
              Close integration
            </button>
          </header>
          <div className="min-h-0 overflow-y-auto p-4 text-sm">
            {loading ? (
              <p role="status">
                {record?.status === "applying"
                  ? "Checking integration status…"
                  : "Loading integration preview…"}
              </p>
            ) : null}
            {record ? (
              <p className="mb-3 text-fg-muted" data-testid="integration-status" role="status">
                {integrationStatusText(record.status)}
              </p>
            ) : null}
            {record?.status === "applied" ? (
              <p className="mb-3 rounded bg-warning/10 p-2 text-warning">
                Changes are in the working tree as a no-commit merge. Complete the merge in Git.
              </p>
            ) : null}
            {record?.status === "conflict" ? (
              <section aria-label="Merge conflicts" className="mb-3 rounded bg-warning/10 p-2">
                <h3 className="font-medium text-warning">Resolve or abort this merge conflict</h3>
                {record.conflictFiles?.length ? (
                  <ul className="mt-1 list-disc pl-5 text-fg-muted">
                    {record.conflictFiles.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                ) : null}
                <button className="mt-2" disabled={busy} onClick={() => void abort()} type="button">
                  {busy ? "Aborting…" : "Abort merge"}
                </button>
              </section>
            ) : null}
            {preview ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <h3 className="text-xs text-fg-faint uppercase">Source branch</h3>
                    <p className="break-all font-mono text-fg">{preview.sourceBranch}</p>
                  </div>
                  <div>
                    <h3 className="text-xs text-fg-faint uppercase">Target branch</h3>
                    <p className="break-all font-mono text-fg">{preview.targetBranch}</p>
                  </div>
                </div>
                <section className="mt-4">
                  <h3 className="font-medium text-fg">Commits</h3>
                  {preview.commits.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5 text-fg-muted">
                      {preview.commits.map((commit) => (
                        <li key={commit.sha}>
                          <span className="mr-2 font-mono text-2xs">{commit.sha.slice(0, 8)}</span>
                          {commit.subject}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-fg-muted">No commits to apply.</p>
                  )}
                  {preview.omittedCommitCount > 0 ? (
                    <p className="mt-1 text-2xs text-fg-faint">
                      {preview.omittedCommitCount} more commits omitted.
                    </p>
                  ) : null}
                </section>
                <section className="mt-4">
                  <h3 className="font-medium text-fg">Changed files</h3>
                  {preview.changedFiles.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5 text-fg-muted">
                      {preview.changedFiles.map((file) => (
                        <li key={`${file.path}:${file.status}`}>
                          <span className="mr-2 text-fg-faint">{file.status}</span>
                          <span className="font-mono">{file.path}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-fg-muted">No changed files.</p>
                  )}
                  {preview.omittedChangedFileCount > 0 ? (
                    <p className="mt-1 text-2xs text-fg-faint">
                      {preview.omittedChangedFileCount} more files omitted.
                    </p>
                  ) : null}
                </section>
                <section className="mt-4">
                  <h3 className="font-medium text-fg">Diff summary</h3>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-elevated p-2 font-mono text-2xs text-fg-muted">
                    {preview.diffSummary || "No diff summary available."}
                  </pre>
                </section>
              </>
            ) : null}
            {noChanges ? (
              <p className="mt-3 text-fg-muted">This preview contains no changes.</p>
            ) : null}
            {error ? (
              <p className="mt-3 text-danger" role="alert">
                {error}
              </p>
            ) : null}
            {!loading && !preview && (!record || record.status === "ready") && !noChanges ? (
              <button disabled={busy} onClick={() => void requestPreview()} type="button">
                Refresh preview
              </button>
            ) : null}
            {record?.status === "aborted" ? (
              <button disabled={busy} onClick={() => void requestPreview()} type="button">
                Request a new preview
              </button>
            ) : null}
          </div>
          {ready ? (
            <footer className="flex flex-col gap-3 border-t border-hairline px-4 py-3">
              <label className="flex items-start gap-2 text-fg-muted">
                <input
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>I confirm applying this no-commit merge to the target branch.</span>
              </label>
              <div className="flex justify-end gap-2">
                <button disabled={busy} onClick={() => void requestPreview()} type="button">
                  Refresh preview
                </button>
                <button disabled={!confirmed || busy} onClick={() => void apply()} type="button">
                  {busy ? "Applying…" : "Apply no-commit merge"}
                </button>
              </div>
            </footer>
          ) : null}
          {noChanges ? (
            <footer className="flex justify-end border-t border-hairline px-4 py-3">
              <button
                disabled={busy || loading}
                onClick={() => void requestPreview()}
                type="button"
              >
                Refresh preview
              </button>
            </footer>
          ) : null}
          {record?.status === "applying" ? (
            <footer className="flex justify-end border-t border-hairline px-4 py-3">
              <button
                disabled={busy || loading}
                onClick={() => void checkIntegrationStatus()}
                type="button"
              >
                {loading ? "Checking status…" : "Check integration status"}
              </button>
            </footer>
          ) : null}
          {record?.status === "applied" ? (
            <footer className="flex justify-end border-t border-hairline px-4 py-3">
              <button disabled={busy} onClick={() => void abort()} type="button">
                {busy ? "Aborting…" : "Abort merge"}
              </button>
            </footer>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function integrationStatusText(status: GroupIntegrationRecord["status"]): string {
  switch (status) {
    case "ready":
      return "Preview ready. Confirm before applying.";
    case "applying":
      return "Applying the confirmed integration…";
    case "applied":
      return "Applied as a no-commit change in the working tree.";
    case "conflict":
      return "Integration has conflicts that need resolution.";
    case "aborted":
      return "The pending merge was aborted.";
    case "no_changes":
      return "There are no changes to integrate.";
  }
}
