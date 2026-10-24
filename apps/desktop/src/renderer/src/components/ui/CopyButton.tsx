import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

type CopyButtonProps = {
  /** The exact text placed on the clipboard (raw markdown for AI, raw text for user). */
  text: string;
  label?: string;
  className?: string;
};

/**
 * Small icon button that copies `text` and cross-fades to a check for ~1.6s.
 * Icon only: the check is the confirmation (styles in `.copy-button`, app.css).
 */
export function CopyButton({ text, label = "Copy", className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handleCopy = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };

  return (
    <button
      aria-label={label}
      className={cn(
        "copy-button relative flex size-6 items-center justify-center rounded-md text-fg-faint hover:bg-hover hover:text-fg-muted",
        className,
      )}
      data-copied={copied ? "true" : undefined}
      onClick={handleCopy}
      type="button"
    >
      <IconCopy aria-hidden className="copy-button-icon copy-button-idle" size={13} stroke={1.8} />
      <IconCheck aria-hidden className="copy-button-icon copy-button-done" size={13} stroke={1.9} />
    </button>
  );
}
