import {
  IconCircles,
  IconMessageCircle,
  IconPlugConnected,
  IconSettings,
} from "@tabler/icons-react";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import type { PrimaryDestination } from "./navigation-state";

export type { PrimaryDestination } from "./navigation-state";

export const APP_RAIL_WIDTH = 68;

const DESTINATIONS = [
  { id: "groups", label: "Groups", icon: IconCircles },
  { id: "direct-messages", label: "Direct Messages", icon: IconMessageCircle },
  { id: "connections", label: "Connections", icon: IconPlugConnected },
] as const;

export function AppRail({
  active,
  onNavigate,
  nativeTitlebar = false,
}: {
  active: PrimaryDestination;
  onNavigate(destination: PrimaryDestination): void;
  nativeTitlebar?: boolean;
}) {
  return (
    <nav
      aria-label="Primary navigation"
      className={cn("app-rail", nativeTitlebar && "app-rail-native-titlebar")}
      data-native-titlebar-clearance={nativeTitlebar ? "true" : undefined}
      data-shell-layer="app-rail"
    >
      <div aria-hidden className="app-rail-mark" title="Modus">
        M
      </div>
      <div className="flex flex-col gap-1">
        {DESTINATIONS.map(({ id, icon: Icon, label }) => (
          <button
            aria-current={active === id ? "page" : undefined}
            className={cn("app-rail-item", active === id && "app-rail-item-selected")}
            key={id}
            onClick={() => onNavigate(id)}
            type="button"
          >
            <Icon aria-hidden size={ICON.md} stroke={ICON_STROKE.md} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="mt-auto">
        <button
          aria-current={active === "settings" ? "page" : undefined}
          className={cn("app-rail-item", active === "settings" && "app-rail-item-selected")}
          onClick={() => onNavigate("settings")}
          type="button"
        >
          <IconSettings aria-hidden size={ICON.md} stroke={ICON_STROKE.md} />
          <span>Settings</span>
        </button>
      </div>
    </nav>
  );
}
