import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Tooltip } from "./Tooltip";

/** Shared chrome toolbar glyph — one size for Inspector / App / sub-toolbars. */
export const TOOLBAR_ICON = { size: 16, stroke: 1.7 } as const;

type ToolbarButtonProps = {
  children: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Toggle buttons: exposes the on/off state to assistive tech as `aria-pressed`. */
  pressed?: boolean;
};

/**
 * Shared toolbar icon button (hit area from `.toolbar-icon-button` in app.css).
 * One definition → identical look, hover, tooltip, and tokens everywhere so
 * left/right panel controls stay symmetric and theme-adaptive.
 */
export function ToolbarButton({
  children,
  label,
  active = false,
  disabled = false,
  onClick,
  pressed,
}: ToolbarButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        aria-label={label}
        aria-pressed={pressed}
        className={cn(
          "toolbar-icon-button app-no-drag flex items-center justify-center rounded-md transition-colors hover:bg-hover",
          active && "bg-active",
          disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
        )}
        data-active={active}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {children}
      </button>
    </Tooltip>
  );
}
