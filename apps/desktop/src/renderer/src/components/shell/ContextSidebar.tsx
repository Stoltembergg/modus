import type { PropsWithChildren } from "react";
import { cn } from "../../lib/cn";

export type ContextSidebarProps = PropsWithChildren<{
  className?: string | undefined;
}>;

/** Layout marker for the contextual list beside the primary rail. */
export function ContextSidebar({ children, className }: ContextSidebarProps) {
  return (
    <div
      className={cn("contents", className)}
      data-shell-layer="context-sidebar"
      data-testid="context-sidebar"
    >
      {children}
    </div>
  );
}
