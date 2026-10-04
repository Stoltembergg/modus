import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import {
  IconBrandVisualStudio,
  IconCheck,
  IconChevronDown,
  IconCircles,
  IconDeviceLaptop,
  IconDots,
  IconGitBranch,
  IconLayoutSidebarRight,
  IconListDetails,
  IconSettings,
  IconSourceCode,
  IconVersions,
} from "@tabler/icons-react";
import { AnimatePresence, m } from "motion/react";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import type { WorkspaceInfo } from "../../../../shared/contracts";
import { GroupMenuItem } from "../../components/sidebar-groups/helpers";
import { TOOLBAR_ICON, ToolbarButton } from "../../components/ui/ToolbarButton";
import { cn } from "../../lib/cn";
import type { WidthTier } from "../../lib/useWidthTier";

/**
 * Right side of the 1:1 window top bar (moved out of App.tsx in L3c).
 * The tier comes from the top bar's own width (`TOP_BAR_BREAKPOINTS`, same cut-offs as the
 * group header). `lg` / `md`: Environment + right-sidebar toggle, icon-only with labels.
 * `sm`: both collapse into one "Session actions" menu; Environment then opens its popover
 * anchored to that menu's trigger.
 */
export function HeaderActions({
  activeWorkspace,
  branch,
  environmentStats,
  inspectorOpen,
  onOpenSettings,
  onToggleInspector,
  tier = "lg",
}: {
  activeWorkspace: WorkspaceInfo | null;
  branch: string | undefined;
  environmentStats: { added: number; removed: number };
  inspectorOpen: boolean;
  onOpenSettings(): void;
  onToggleInspector(): void;
  tier?: WidthTier;
}) {
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const overflowRef = useRef<HTMLButtonElement>(null);
  // sm: "Environment" opens the popover once the menu has finished closing (otherwise the
  // menu's focus return would count as an outside interaction and dismiss it at once).
  const openEnvironmentAfterMenu = useRef(false);
  const inspectorLabel = inspectorOpen ? "Hide right sidebar" : "Show right sidebar";
  const environment = (
    <EnvironmentPopover
      activeWorkspace={activeWorkspace}
      branch={branch}
      environmentStats={environmentStats}
      onOpenChange={setEnvironmentOpen}
      onOpenSettings={onOpenSettings}
      open={environmentOpen}
      {...(tier === "sm" ? { anchor: overflowRef } : {})}
    />
  );
  if (tier === "sm") {
    return (
      <div className="app-no-drag flex h-8 items-center gap-1" data-width-tier={tier}>
        <Menu.Root
          onOpenChangeComplete={(open) => {
            if (open || !openEnvironmentAfterMenu.current) return;
            openEnvironmentAfterMenu.current = false;
            setEnvironmentOpen(true);
          }}
        >
          <Menu.Trigger
            aria-label="Session actions"
            className="toolbar-icon-button flex items-center justify-center rounded-md outline-none transition-colors hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ring/50 data-popup-open:bg-active"
            data-testid="session-actions-trigger"
            ref={overflowRef}
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
                <GroupMenuItem
                  icon={<IconListDetails size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />}
                  onClick={() => {
                    openEnvironmentAfterMenu.current = true;
                  }}
                >
                  Environment
                </GroupMenuItem>
                <Menu.CheckboxItem
                  checked={inspectorOpen}
                  className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-fg text-sm outline-none select-none data-highlighted:bg-hover"
                  onCheckedChange={() => onToggleInspector()}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {inspectorOpen ? (
                      <IconCheck size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
                    ) : (
                      <IconLayoutSidebarRight
                        size={TOOLBAR_ICON.size}
                        stroke={TOOLBAR_ICON.stroke}
                      />
                    )}
                  </span>
                  Right sidebar
                </Menu.CheckboxItem>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        {environment}
      </div>
    );
  }
  return (
    <div className="app-no-drag flex h-8 items-center gap-1" data-width-tier={tier}>
      {environment}
      <ToolbarButton active={inspectorOpen} label={inspectorLabel} onClick={onToggleInspector}>
        <IconLayoutSidebarRight size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
      </ToolbarButton>
    </div>
  );
}

function EnvironmentPopover({
  activeWorkspace,
  branch,
  environmentStats,
  onOpenSettings,
  open,
  onOpenChange,
  anchor,
}: {
  activeWorkspace: WorkspaceInfo | null;
  branch: string | undefined;
  environmentStats: { added: number; removed: number };
  onOpenSettings(): void;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** sm: no trigger of its own; the popover anchors to (and returns focus to) this element. */
  anchor?: RefObject<HTMLElement | null>;
}) {
  return (
    <Popover.Root onOpenChange={onOpenChange} open={open}>
      {anchor ? null : (
        <Popover.Trigger
          aria-label="Environment"
          className={cn(
            "toolbar-icon-button flex items-center justify-center rounded-md transition-colors hover:bg-hover",
            open && "bg-active",
          )}
          data-active={open}
        >
          <IconListDetails size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
        </Popover.Trigger>
      )}
      <AnimatePresence>
        {open ? (
          <Popover.Portal keepMounted>
            <Popover.Positioner
              align="end"
              side="bottom"
              sideOffset={10}
              {...(anchor ? { anchor } : {})}
            >
              <Popover.Popup
                aria-label="Environment"
                render={<m.div />}
                {...(anchor ? { finalFocus: anchor } : {})}
              >
                <m.div
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  className="popup-chrome w-[min(375px,calc(100vw-24px))] p-5 outline-none"
                  exit={{ opacity: 0, scale: 0.98, y: -6 }}
                  initial={{ opacity: 0, scale: 0.98, y: -6 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-sm font-normal text-fg-subtle">Environment</h2>
                    <button
                      aria-label="Environment settings"
                      className="toolbar-icon-button flex items-center justify-center rounded-md transition-colors hover:bg-hover"
                      onClick={() => {
                        onOpenChange(false);
                        onOpenSettings();
                      }}
                      type="button"
                    >
                      <IconSettings size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
                    </button>
                  </div>
                  <div className="space-y-3 text-sm text-fg">
                    <EnvironmentRow icon={<IconSourceCode size={16} stroke={1.7} />}>
                      <span>Changes</span>
                      <span className="ml-auto font-mono text-success">
                        +{environmentStats.added}
                      </span>
                      <span className="font-mono text-danger">-{environmentStats.removed}</span>
                    </EnvironmentRow>
                    <EnvironmentRow icon={<IconDeviceLaptop size={16} stroke={1.7} />}>
                      <span>{activeWorkspace ? "Local" : "No workspace"}</span>
                      <IconChevronDown className="text-fg-faint" size={12} stroke={2} />
                    </EnvironmentRow>
                    <EnvironmentRow icon={<IconGitBranch size={16} stroke={1.7} />}>
                      <span>{branch ?? "No branch"}</span>
                    </EnvironmentRow>
                    <EnvironmentRow icon={<IconVersions size={16} stroke={1.7} />}>
                      <span>Commit or push</span>
                    </EnvironmentRow>
                  </div>

                  <div className="my-5 h-px bg-hairline-soft" />

                  <section>
                    <h2 className="mb-3 text-sm font-normal text-fg-subtle">Sources</h2>
                    <div className="flex items-center gap-3 text-fg-subtle">
                      <IconCircles size={18} stroke={1.6} />
                      <span className="flex size-5 items-center justify-center rounded bg-[#2f5dff] text-white">
                        <IconBrandVisualStudio size={15} stroke={1.7} />
                      </span>
                      <IconCircles size={18} stroke={1.6} />
                    </div>
                  </section>
                </m.div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}

function EnvironmentRow({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    <button
      className="flex h-8 w-full items-center gap-3 rounded-md px-1 text-left transition-colors hover:bg-hover"
      type="button"
    >
      <span className="flex size-5 items-center justify-center text-fg">{icon}</span>
      {children}
    </button>
  );
}
