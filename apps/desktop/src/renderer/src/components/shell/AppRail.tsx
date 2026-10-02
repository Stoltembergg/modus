import { IconCircles, IconMessageCircle, IconSettings } from "@tabler/icons-react";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { ModusBot } from "../ui/ModusBot";
import type { PrimaryDestination } from "./navigation-state";

export type { PrimaryDestination } from "./navigation-state";

export const APP_RAIL_WIDTH = 68;

const DESTINATIONS = [
  { id: "groups", label: "Groups", icon: IconCircles },
  { id: "direct-messages", label: "Direct Messages", icon: IconMessageCircle },
] as const;

export function AppRail({
  active,
  onNavigate,
  topChromeClearance = false,
}: {
  active: PrimaryDestination;
  onNavigate(destination: PrimaryDestination): void;
  topChromeClearance?: boolean;
}) {
  return (
    <nav
      aria-label="Primary navigation"
      className={cn("app-rail", topChromeClearance && "app-rail-top-chrome-clearance")}
      data-top-chrome-clearance={topChromeClearance ? "true" : undefined}
      data-shell-layer="app-rail"
    >
      <div className="app-rail-mark" data-testid="app-rail-brand" title="Modus">
        <ModusBot className="size-7" motionScale={0.25} />
      </div>
      <div className="flex flex-col gap-1">
        {DESTINATIONS.map(({ id, icon: Icon, label }) => (
          <button
            aria-label={label}
            aria-current={active === id ? "page" : undefined}
            className={cn("app-rail-item", active === id && "app-rail-item-selected")}
            key={id}
            onClick={() => onNavigate(id)}
            title={label}
            type="button"
          >
            <Icon aria-hidden size={ICON.rail} stroke={ICON_STROKE.rail} />
          </button>
        ))}
      </div>
      <div className="mt-auto">
        <button
          aria-label="Settings"
          aria-current={active === "settings" ? "page" : undefined}
          className={cn("app-rail-item", active === "settings" && "app-rail-item-selected")}
          onClick={() => onNavigate("settings")}
          title="Settings"
          type="button"
        >
          <IconSettings aria-hidden size={ICON.rail} stroke={ICON_STROKE.rail} />
        </button>
      </div>
    </nav>
  );
}
