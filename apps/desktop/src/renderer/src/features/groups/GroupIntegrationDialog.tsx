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
import { type GroupTextFn, useGroupText } from "./groupRoomI18n";

type Props = {
  groupId: string;
  taskId: string;
  onClose(): void;
};

export function GroupIntegrationDialog({ groupId, taskId, onClose }: Props) {
  const t = useGroupText();
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
        setError(describeGroupError(cause, t.locale));
      } finally {
        setLoading(false);
      }
    },
    [reloadState, t.locale, taskId],
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
        if (!disposed) setError(describeGroupError(cause, t.locale));
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
        setError(describeGroupError(cause, t.locale)),
      );
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [acceptState, groupId, reloadState, requestPreview, t.locale, taskId]);

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
      setError(describeGroupError(cause, t.locale));
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
      setError(describeGroupError(cause, t.locale));
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
      setError(describeGroupError(cause, t.locale));
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
            <Dialog.Title className="font-medium text-fg">{t("integration.title")}</Dialog.Title>
            <button onClick={onClose} type="button">
              {t("integration.close")}
            </button>
          </header>
          <div className="min-h-0 overflow-y-auto p-4 text-sm">
            {loading ? (
              <p role="status">
                {record?.status === "applying"
                  ? t("integration.loadingStatus")
                  : t("integration.loadingPreview")}
              </p>
            ) : null}
            {record ? (
              <p className="mb-3 text-fg-muted" data-testid="integration-status" role="status">
                {integrationStatusText(record.status, t)}
              </p>
            ) : null}
            {record?.status === "applied" ? (
              <p className="mb-3 rounded bg-warning/10 p-2 text-warning">
                {t("integration.noCommitExplanation")}
              </p>
            ) : null}
            {record?.status === "conflict" ? (
              <section
                aria-label={t("integration.conflicts")}
                className="mb-3 rounded bg-warning/10 p-2"
              >
                <h3 className="font-medium text-warning">{t("integration.resolveConflicts")}</h3>
                {record.conflictFiles?.length ? (
                  <ul className="mt-1 list-disc pl-5 text-fg-muted">
                    {record.conflictFiles.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                ) : null}
                <button className="mt-2" disabled={busy} onClick={() => void abort()} type="button">
                  {busy ? t("integration.aborting") : t("integration.abort")}
                </button>
              </section>
            ) : null}
            {preview ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <h3 className="text-xs text-fg-faint uppercase">
                      {t("integration.sourceBranch")}
                    </h3>
                    <p className="break-all font-mono text-fg">{preview.sourceBranch}</p>
                  </div>
                  <div>
                    <h3 className="text-xs text-fg-faint uppercase">
                      {t("integration.targetBranch")}
                    </h3>
                    <p className="break-all font-mono text-fg">{preview.targetBranch}</p>
                  </div>
                </div>
                <section className="mt-4">
                  <h3 className="font-medium text-fg">{t("integration.commits")}</h3>
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
                    <p className="mt-1 text-fg-muted">{t("integration.noCommits")}</p>
                  )}
                  {preview.omittedCommitCount > 0 ? (
                    <p className="mt-1 text-2xs text-fg-faint">
                      {t("integration.commitsOmitted", { count: preview.omittedCommitCount })}
                    </p>
                  ) : null}
                </section>
                <section className="mt-4">
                  <h3 className="font-medium text-fg">{t("integration.changedFiles")}</h3>
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
                    <p className="mt-1 text-fg-muted">{t("integration.noChangedFiles")}</p>
                  )}
                  {preview.omittedChangedFileCount > 0 ? (
                    <p className="mt-1 text-2xs text-fg-faint">
                      {t("integration.filesOmitted", { count: preview.omittedChangedFileCount })}
                    </p>
                  ) : null}
                </section>
                <section className="mt-4">
                  <h3 className="font-medium text-fg">{t("integration.diffSummary")}</h3>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-elevated p-2 font-mono text-2xs text-fg-muted">
                    {preview.diffSummary || t("integration.noDiffSummary")}
                  </pre>
                </section>
              </>
            ) : null}
            {noChanges ? <p className="mt-3 text-fg-muted">{t("integration.noChanges")}</p> : null}
            {error ? (
              <p className="mt-3 text-danger" role="alert">
                {error}
              </p>
            ) : null}
            {!loading && !preview && (!record || record.status === "ready") && !noChanges ? (
              <button disabled={busy} onClick={() => void requestPreview()} type="button">
                {t("integration.refreshPreview")}
              </button>
            ) : null}
            {record?.status === "aborted" ? (
              <button disabled={busy} onClick={() => void requestPreview()} type="button">
                {t("integration.requestPreview")}
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
                <span>{t("integration.confirmMerge")}</span>
              </label>
              <div className="flex justify-end gap-2">
                <button disabled={busy} onClick={() => void requestPreview()} type="button">
                  {t("integration.refreshPreview")}
                </button>
                <button disabled={!confirmed || busy} onClick={() => void apply()} type="button">
                  {busy ? t("integration.applying") : t("integration.applyMerge")}
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
                {t("integration.refreshPreview")}
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
                {loading ? t("integration.checkingStatus") : t("integration.checkStatus")}
              </button>
            </footer>
          ) : null}
          {record?.status === "applied" ? (
            <footer className="flex justify-end border-t border-hairline px-4 py-3">
              <button disabled={busy} onClick={() => void abort()} type="button">
                {busy ? t("integration.aborting") : t("integration.abort")}
              </button>
            </footer>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function integrationStatusText(status: GroupIntegrationRecord["status"], t: GroupTextFn): string {
  switch (status) {
    case "ready":
      return t("integration.status.ready");
    case "applying":
      return t("integration.status.applying");
    case "applied":
      return t("integration.status.applied");
    case "conflict":
      return t("integration.status.conflict");
    case "aborted":
      return t("integration.status.aborted");
    case "no_changes":
      return t("integration.status.noChanges");
  }
}
