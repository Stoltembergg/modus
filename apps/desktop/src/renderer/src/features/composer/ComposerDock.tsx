import type { ReactNode } from "react";

/**
 * One raised surface for prompt input and compact contextual status rails.
 */
export function ComposerDock({
  rails,
  children,
}: {
  /** Homogeneous {@link ComposerRail} nodes; omit empties before passing. */
  rails?: ReactNode;
  children: ReactNode;
}) {
  const hasRails = Boolean(rails);

  return (
    <div
      className="composer-dock-shell surface-raised relative flex flex-col overflow-hidden"
      data-composer-surface
      data-testid="composer-dock"
      data-ui-surface="raised"
    >
      {hasRails ? (
        <div className="composer-dock-rails relative z-0 border-b border-hairline-soft px-2 py-1">
          <div className="flex flex-col gap-1">{rails}</div>
        </div>
      ) : null}
      <div className="relative z-10 min-w-0">{children}</div>
    </div>
  );
}
