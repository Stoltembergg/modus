import { useRef, useState } from "react";
import { SB_ROW } from "./shared";

export function GroupRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const commit = (): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(value);
  };
  return (
    <input
      aria-label="Group name"
      // biome-ignore lint/a11y/noAutofocus: renaming starts a focused edit by design
      autoFocus
      className="min-w-0 flex-1 rounded-md border border-composer-border bg-elevated px-1.5 py-1 text-fg text-xs outline-none focus:border-accent"
      maxLength={120}
      onBlur={commit}
      onChange={(event) => setValue(event.currentTarget.value)}
      onFocusCapture={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          doneRef.current = true;
          onCancel();
        }
      }}
      type="text"
      value={value}
    />
  );
}

