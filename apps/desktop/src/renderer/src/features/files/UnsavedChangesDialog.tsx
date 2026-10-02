import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useRef } from "react";
import { cn } from "../../lib/cn";
import { FILES_DIRTY_COPY } from "./filesDirtyCopy";

type UnsavedChangesDialogProps = {
  open: boolean;
  /** Name of the dirty file (the one that would lose its edits). */
  fileName: string;
  /** Last save failure, shown inline; the dialog stays open. */
  error?: string | undefined;
  busy?: boolean;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
};

const BUTTON =
  "h-8 rounded-md px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/35 disabled:opacity-50";

/**
 * "Save / Discard / Cancel" before leaving a dirty file (C2.2). Base UI alert
 * dialog: focus is trapped inside, Esc (and only the buttons) close it, and
 * Esc is the same as Cancel. Save gets initial focus.
 */
export function UnsavedChangesDialog({
  open,
  fileName,
  error,
  busy = false,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  const saveRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
      open={open}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 ease-out-quint motion-reduce:transition-none",
            "data-ending-style:opacity-0 data-starting-style:opacity-0",
          )}
        />
        <AlertDialog.Popup
          className={cn(
            "-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 w-[min(400px,calc(100vw-2rem))]",
            "origin-center overflow-hidden popup-chrome px-4 pt-3.5 pb-3 outline-none",
            "transition-[transform,opacity,scale] duration-150 ease-out-quint motion-reduce:transition-none",
            "data-ending-style:scale-[0.96] data-ending-style:opacity-0",
            "data-starting-style:scale-[0.96] data-starting-style:opacity-0",
          )}
          data-unsaved-dialog=""
          initialFocus={saveRef}
        >
          <AlertDialog.Title className="font-medium text-fg text-sm">
            {FILES_DIRTY_COPY.dialogTitle(fileName)}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-fg-muted text-xs leading-relaxed">
            {FILES_DIRTY_COPY.dialogDescription}
          </AlertDialog.Description>
          {error ? (
            <div
              className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/8 px-2.5 py-2 text-danger text-xs"
              role="alert"
            >
              {FILES_DIRTY_COPY.saveFailed(error)}
            </div>
          ) : null}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              className={cn(BUTTON, "text-fg-muted hover:bg-hover hover:text-fg")}
              disabled={busy}
              onClick={onCancel}
              type="button"
            >
              {FILES_DIRTY_COPY.cancel}
            </button>
            <button
              className={cn(BUTTON, "text-danger hover:bg-danger/8")}
              disabled={busy}
              onClick={onDiscard}
              type="button"
            >
              {FILES_DIRTY_COPY.discard}
            </button>
            <button
              className={cn(BUTTON, "bg-accent text-white hover:opacity-90")}
              disabled={busy}
              onClick={onSave}
              ref={saveRef}
              type="button"
            >
              {FILES_DIRTY_COPY.save}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
