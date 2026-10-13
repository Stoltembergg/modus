import { IconLayoutSidebarRight } from "@tabler/icons-react";
import { TOOLBAR_ICON, ToolbarButton } from "../../components/ui/ToolbarButton";
import type { WidthTier } from "../../lib/useWidthTier";

/**
 * Right side of the 1:1 window top bar (moved out of App.tsx in L3c).
 * The tier comes from the top bar's own width (`TOP_BAR_BREAKPOINTS`, same cut-offs as the
 * group header). Only the right-sidebar toggle lives here, icon-only in every tier; the
 * pinned To-dos above the Composer is always shown and minimizes from its own header.
 */
export function HeaderActions({
  inspectorOpen,
  onToggleInspector,
  tier = "lg",
}: {
  inspectorOpen: boolean;
  onToggleInspector(): void;
  tier?: WidthTier;
}) {
  const inspectorLabel = inspectorOpen ? "Hide right sidebar" : "Show right sidebar";
  return (
    <div className="app-no-drag flex h-8 items-center gap-1" data-width-tier={tier}>
      <ToolbarButton active={inspectorOpen} label={inspectorLabel} onClick={onToggleInspector}>
        <IconLayoutSidebarRight size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
      </ToolbarButton>
    </div>
  );
}
