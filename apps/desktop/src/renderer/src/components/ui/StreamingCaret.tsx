import { cn } from "../../lib/cn";

type StreamingCaretProps = {
  active: boolean;
  className?: string | undefined;
};

/**
 * Thin muted bar placed right after streaming text. Blinks on/off (~1 s, CSS steps);
 * under reduced motion it holds still at reduced opacity. Renders nothing when idle.
 */
export function StreamingCaret({ active, className }: StreamingCaretProps) {
  if (!active) return null;
  return (
    <span aria-hidden="true" className={cn("streaming-caret", className)}>
      {"\u258F"}
    </span>
  );
}
