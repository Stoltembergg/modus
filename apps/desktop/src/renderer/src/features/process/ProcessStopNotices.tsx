export function ProcessStopNotices({
  notices,
  onDismiss,
}: {
  notices: ReadonlyArray<readonly [string, string]>;
  onDismiss(processId: string): void;
}) {
  return notices.map(([processId, message]) => (
    <div
      className="mx-4 mt-2 flex items-start justify-between gap-3 rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger"
      key={processId}
      role="alert"
    >
      <span>{message}</span>
      <button
        aria-label={`Dismiss stop notice for ${processId}`}
        className="shrink-0 underline underline-offset-2"
        onClick={() => onDismiss(processId)}
        type="button"
      >
        Dismiss
      </button>
    </div>
  ));
}
