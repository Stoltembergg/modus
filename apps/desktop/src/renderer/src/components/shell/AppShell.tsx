import type { PropsWithChildren, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type AppShellProps = PropsWithChildren<{
  className?: string | undefined;
  glassMode?: "native" | "solid" | undefined;
  rail?: ReactNode;
  sidebar?: ReactNode;
  main?: ReactNode;
  activity?: ReactNode;
}>;

/** Root frame for the desktop renderer; the main app continues to own state. */
export function AppShell({
  children,
  className,
  glassMode = "solid",
  rail,
  sidebar,
  main,
  activity,
}: AppShellProps) {
  return (
    <div
      className={cn("app-shell flex h-screen min-h-0 flex-col", className)}
      data-glass-mode={glassMode}
      data-shell-layer="app-shell"
      data-testid="app-shell"
    >
      {rail}
      {sidebar}
      {main}
      {activity}
      {children}
    </div>
  );
}
