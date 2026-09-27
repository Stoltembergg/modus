import {
  IconArrowLeft,
  IconBrain,
  IconBulb,
  IconCube,
  IconGauge,
  IconGavel,
  IconPalette,
  IconPlugConnected,
  IconSearch,
  IconServerCog,
  IconSettings,
  IconUser,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "../../../lib/cn";
import type { SettingsSectionId } from "../settings-types";
import { filterSettingsNav, groupSettingsNav, SETTINGS_NAV_ITEMS } from "../settingsNav";

const SETTINGS_NAV_ICONS: Record<SettingsSectionId, ReactNode> = {
  general: <IconSettings size={16} stroke={1.7} />,
  "model-provider": <IconServerCog size={16} stroke={1.7} />,
  appearance: <IconPalette size={16} stroke={1.7} />,
  personalization: <IconUser size={16} stroke={1.7} />,
  "project-memory": <IconBrain size={16} stroke={1.7} />,
  "harness-insights": <IconBulb size={16} stroke={1.7} />,
  mcp: <IconPlugConnected size={16} stroke={1.7} />,
  skills: <IconCube size={16} stroke={1.7} />,
  subagents: <IconUser size={16} stroke={1.7} />,
  rules: <IconGavel size={16} stroke={1.7} />,
  limits: <IconGauge size={16} stroke={1.7} />,
};

export function SettingsSidebar({
  activeSection,
  query,
  onBack,
  onQueryChange,
  onSectionChange,
}: {
  activeSection: SettingsSectionId;
  query: string;
  onBack(): void;
  onQueryChange(query: string): void;
  onSectionChange(section: SettingsSectionId): void;
}) {
  const visibleItems = filterSettingsNav(SETTINGS_NAV_ITEMS, query);

  return (
    <aside className="flex w-[260px] shrink-0 flex-col bg-panel px-2.5 py-3">
      <button
        className="mb-4 flex h-8 items-center gap-2 rounded-md px-2 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        onClick={onBack}
        type="button"
      >
        <IconArrowLeft size={16} stroke={1.7} />
        Back
      </button>

      <label className="relative mb-5 block">
        <IconSearch
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint"
          size={15}
          stroke={1.7}
        />
        <input
          className="h-9 w-full rounded-lg border border-hairline-soft bg-surface/45 pr-3 pl-8 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-hairline-strong"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search settings..."
          value={query}
        />
      </label>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {visibleItems.length > 0 ? (
          groupSettingsNav(visibleItems).map(({ group, items }) => (
            <SettingsNavGroup key={group.id} title={group.title}>
              {items.map((item) => (
                <SettingsNavItem
                  active={activeSection === item.id}
                  icon={SETTINGS_NAV_ICONS[item.id]}
                  key={item.id}
                  onClick={() => onSectionChange(item.id)}
                >
                  {item.label}
                </SettingsNavItem>
              ))}
            </SettingsNavGroup>
          ))
        ) : (
          <p className="px-2 text-sm text-fg-muted">No settings match</p>
        )}
      </div>

      <div className="border-hairline-soft border-t px-2 pt-3 text-xs text-fg-faint">
        <div>Modus Desktop</div>
        <div className="mt-1">v0.1.0</div>
      </div>
    </aside>
  );
}

function SettingsNavGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="mb-7">
      <h3 className="mb-2 px-2 text-xs font-normal text-fg-faint">{title}</h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function SettingsNavItem({
  active = false,
  children,
  icon,
  onClick,
}: {
  active?: boolean;
  children: string;
  icon: ReactNode;
  onClick(): void;
}) {
  return (
    <button
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors",
        active ? "bg-active text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
      )}
      onClick={onClick}
      type="button"
    >
      <span className={active ? "text-fg" : "text-fg-subtle"}>{icon}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}
