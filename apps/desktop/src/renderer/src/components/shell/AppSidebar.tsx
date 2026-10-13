import {
  IconEdit,
  IconMessageCircle,
  IconPin,
  IconPinnedOff,
  IconSettings,
  IconUserPlus,
} from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { cn } from "../../lib/cn";
import { useShellText } from "../../lib/shellText";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { ModusBot } from "../ui/ModusBot";
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_WIDTH,
  Sidebar,
  SidebarBody,
  SidebarLink,
  useSidebar,
} from "../ui/sidebar";
import type { PrimaryDestination } from "./navigation-state";

export type AppSidebarProps = {
  active: PrimaryDestination;
  onNavigate(destination: PrimaryDestination): void;
  /** Pinned = always 300px and in the layout; unpinned = 60px rail that expands on hover. */
  pinned: boolean;
  onPinnedChange(pinned: boolean): void;
  onNewMessage(): void;
  canCreateSession: boolean;
  onNewProfile?: (() => void) | undefined;
  /** macOS: leave room for the traffic lights above the logo. */
  trafficLightClearance?: boolean;
  /** Contextual list (projects and chats) shown while expanded. */
  children?: ReactNode;
};

export const SIDEBAR_PINNED_KEY = "modus.sidebar.pinned";

/** Saved pin choice; with nothing saved the sidebar starts as the collapsed rail. */
export function readSidebarPinned(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_PINNED_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarPinned(pinned: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_PINNED_KEY, pinned ? "true" : "false");
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}

/** Width the layout reserves for the sidebar (an unpinned hover never reflows main). */
export function appSidebarReservedWidth(pinned: boolean): number {
  return pinned ? SIDEBAR_EXPANDED_WIDTH : SIDEBAR_COLLAPSED_WIDTH;
}

/**
 * The single left sidebar: replaces the old icon rail + context panel pair
 * (a sidebar inside another sidebar) with one animated column.
 */
export function AppSidebar({
  active,
  onNavigate,
  pinned,
  onPinnedChange,
  onNewMessage,
  canCreateSession,
  onNewProfile,
  trafficLightClearance = false,
  children,
}: AppSidebarProps) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const t = useShellText();
  return (
    <div
      className="app-sidebar-slot relative h-full shrink-0"
      data-pinned={pinned ? "true" : "false"}
      data-shell-layer="app-sidebar"
      data-testid="app-sidebar"
      style={{ width: appSidebarReservedWidth(pinned) }}
    >
      <Sidebar locked={pinned || active === "settings"} open={hoverOpen} setOpen={setHoverOpen}>
        <SidebarBody
          aria-label="Primary navigation"
          className={cn(
            "app-context-sidebar justify-between gap-3 px-2 pb-2",
            trafficLightClearance ? "pt-10" : "pt-3",
            !pinned && "absolute inset-y-0 left-0 z-40",
          )}
          mobileLabel={t("shell.menu")}
          role="navigation"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden">
            <Brand
              pinned={pinned}
              onPinnedChange={onPinnedChange}
              pinLabel={pinned ? t("shell.unpinSidebar") : t("shell.pinSidebar")}
            />
            <div className="mt-4 flex flex-col gap-0.5">
              <SidebarLink
                disabled={!canCreateSession}
                link={{
                  label: t("shell.newMessage"),
                  icon: <IconEdit size={ICON.rail} stroke={ICON_STROKE.rail} />,
                  onClick: onNewMessage,
                }}
              />
              <SidebarLink
                active={active === "direct-messages"}
                link={{
                  label: t("shell.projects"),
                  icon: <IconMessageCircle size={ICON.rail} stroke={ICON_STROKE.rail} />,
                  onClick: () => onNavigate("direct-messages"),
                }}
              />
              {onNewProfile && active === "direct-messages" ? (
                <SidebarLink
                  link={{
                    label: t("shell.newProfile"),
                    icon: <IconUserPlus size={ICON.rail} stroke={ICON_STROKE.rail} />,
                    onClick: onNewProfile,
                  }}
                />
              ) : null}
            </div>
            <ContextList>{children}</ContextList>
          </div>
          <div className="pt-2">
            <SidebarLink
              active={active === "settings"}
              link={{
                label: t("shell.settings"),
                icon: <IconSettings size={ICON.rail} stroke={ICON_STROKE.rail} />,
                onClick: () => onNavigate("settings"),
              }}
            />
          </div>
        </SidebarBody>
      </Sidebar>
    </div>
  );
}

function Brand({
  pinned,
  onPinnedChange,
  pinLabel,
}: {
  pinned: boolean;
  onPinnedChange(pinned: boolean): void;
  pinLabel: string;
}) {
  const { open } = useSidebar();
  return (
    <div className="flex h-8 items-center gap-2 pl-[6px]" data-testid="app-rail-brand">
      <ModusBot className="size-7 shrink-0" motionScale={0.25} />
      {open ? (
        <>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">Modus</span>
          <button
            aria-label={pinLabel}
            aria-pressed={pinned}
            className="app-sidebar-icon-button"
            onClick={() => onPinnedChange(!pinned)}
            title={pinLabel}
            type="button"
          >
            {pinned ? (
              <IconPinnedOff aria-hidden size={ICON.sm} stroke={ICON_STROKE.sm} />
            ) : (
              <IconPin aria-hidden size={ICON.sm} stroke={ICON_STROKE.sm} />
            )}
          </button>
        </>
      ) : null}
    </div>
  );
}

/** The contextual list only exists while expanded; collapsed shows just the icons. */
function ContextList({ children }: { children?: ReactNode }) {
  const { open } = useSidebar();
  if (!open || !children) return <div className="flex-1" />;
  return (
    <div
      className="mt-3 flex min-h-0 flex-1 flex-col pt-2"
      data-shell-layer="context-sidebar"
      data-testid="context-sidebar"
    >
      {children}
    </div>
  );
}
