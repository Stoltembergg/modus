import type { ReactNode } from "react";

/** A highlighted `@member` inside a room message. */
export function MentionChip({ children }: { children: ReactNode }) {
  return (
    <span
      className="rounded-sm bg-accent/12 px-1 py-px font-medium text-accent"
      data-testid="mention-chip"
    >
      {children}
    </span>
  );
}
