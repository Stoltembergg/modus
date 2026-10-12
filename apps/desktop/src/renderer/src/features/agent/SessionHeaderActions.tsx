import { Menu } from "@base-ui/react/menu";
import { IconCheck, IconDots, IconLayoutSidebarRight, IconListCheck } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { TOOLBAR_ICON, ToolbarButton } from "../../components/ui/ToolbarButton";
import { toggleTaskChecklist, useTaskChecklistVisible } from "../../lib/taskChecklist";
import type { WidthTier } from "../../lib/useWidthTier";

/**
 * Right side of the 1:1 window top bar (moved out of App.tsx in L3c).
 * The tier comes from the top bar's own width (`TOP_BAR_BREAKPOINTS`, same cut-offs as the
 * group header). `lg` / `md`: task-checklist toggle + right-sidebar toggle, icon-only with
 * labels. `sm`: both collapse into one "Session actions" menu as checkbox items.
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
  const checklistVisible = useTaskChecklistVisible();
  const inspectorLabel = inspectorOpen ? "Hide right sidebar" : "Show right sidebar";
  const checklistLabel = checklistVisible ? "Hide task checklist" : "Show task checklist";
  if (tier === "sm") {
    return (
      <div className="app-no-drag flex h-8 items-center gap-1" data-width-tier={tier}>
        <Menu.Root>
          <Menu.Trigger
            aria-label="Session actions"
            className="toolbar-icon-button flex items-center justify-center rounded-md outline-none transition-colors hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ring/50 data-popup-open:bg-active"
            data-testid="session-actions-trigger"
            title="Session actions"
          >
            <IconDots size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="end" side="bottom" sideOffset={6}>
              <Menu.Popup
                className="origin-(--transform-origin) min-w-[200px] popup-chrome popup-motion p-1"
                data-testid="session-actions-menu"
              >
                <CheckItem
                  checked={checklistVisible}
                  icon={<IconListCheck size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />}
                  label="Task checklist"
                  onToggle={toggleTaskChecklist}
                />
                <CheckItem
                  checked={inspectorOpen}
                  icon={
                    <IconLayoutSidebarRight size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
                  }
                  label="Right sidebar"
                  onToggle={onToggleInspector}
                />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    );
  }
  return (
    <div className="app-no-drag flex h-8 items-center gap-1" data-width-tier={tier}>
      <ToolbarButton active={checklistVisible} label={checklistLabel} onClick={toggleTaskChecklist}>
        <IconListCheck size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
      </ToolbarButton>
      <ToolbarButton active={inspectorOpen} label={inspectorLabel} onClick={onToggleInspector}>
        <IconLayoutSidebarRight size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
      </ToolbarButton>
    </div>
  );
}

function CheckItem({
  checked,
  icon,
  label,
  onToggle,
}: {
  checked: boolean;
  icon: ReactNode;
  label: string;
  onToggle(): void;
}) {
  return (
    <Menu.CheckboxItem
      checked={checked}
      className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-fg text-sm outline-none select-none data-highlighted:bg-hover"
      onCheckedChange={() => onToggle()}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {checked ? <IconCheck size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} /> : icon}
      </span>
      {label}
    </Menu.CheckboxItem>
  );
}
