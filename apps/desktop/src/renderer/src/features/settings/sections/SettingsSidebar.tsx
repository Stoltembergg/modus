import {
  IconArrowLeft,
  IconCube,
  IconGavel,
  IconPalette,
  IconPlugConnected,
  IconSearch,
  IconServerCog,
  IconSettings,
  IconUser,
  IconUserCircle,
} from "@tabler/icons-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { cn } from "../../../lib/cn";
import { useSettingsText } from "../../../lib/settingsText";
import type { SettingsSectionId } from "../settings-types";
import {
  filterSettingsNav,
  groupSettingsNav,
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
} from "../settingsNav";

const SETTINGS_NAV_ICONS: Record<SettingsSectionId, ReactNode> = {
  general: <IconSettings size={16} stroke={1.7} />,
  account: <IconUserCircle size={16} stroke={1.7} />,
  "model-provider": <IconServerCog size={16} stroke={1.7} />,
  appearance: <IconPalette size={16} stroke={1.7} />,
  personalization: <IconUser size={16} stroke={1.7} />,
  mcp: <IconPlugConnected size={16} stroke={1.7} />,
  skills: <IconCube size={16} stroke={1.7} />,
  rules: <IconGavel size={16} stroke={1.7} />,
};

export function SettingsSidebar({
  activeSection,
  embedded = false,
  query,
  onBack,
  onQueryChange,
  onSectionChange,
}: {
  activeSection: SettingsSectionId;
  /** Rendered inside the app sidebar: fill it, no own column chrome. */
  embedded?: boolean;
  query: string;
  onBack(): void;
  onQueryChange(query: string): void;
  onSectionChange(section: SettingsSectionId): void;
}) {
  const t = useSettingsText();
  const localizedItems = useMemo(
    () =>
      SETTINGS_NAV_ITEMS.map((item) => ({
        ...item,
        label: t(item.labelKey),
      })),
    [t],
  );
  const localizedGroups = useMemo(
    () =>
      SETTINGS_NAV_GROUPS.map((group) => ({
        ...group,
        title: t(group.titleKey),
      })),
    [t],
  );
  const visibleItems = filterSettingsNav(localizedItems, query);
  const version = useAppVersion();

  return (
    <aside
      className={cn(
        "flex flex-col",
        embedded
          ? "min-h-0 flex-1 px-1 pt-1"
          : "app-settings-sidebar w-[260px] shrink-0 bg-panel px-2.5 py-3",
      )}
      data-settings-nav={embedded ? "embedded" : "standalone"}
    >
      <button
        className="mb-4 flex h-8 items-center gap-2 rounded-md px-2 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        onClick={onBack}
        type="button"
      >
        <IconArrowLeft size={16} stroke={1.7} />
        {t("settings.window.back")}
      </button>

      <label className="relative mb-4 block">
        <IconSearch
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint"
          size={15}
          stroke={1.7}
        />
        <input
          className="h-9 w-full rounded-lg bg-surface/45 pr-3 pl-8 text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:bg-surface focus-visible:ring-2 focus-visible:ring-focus-ring/35"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("settings.window.searchPlaceholder")}
          value={query}
        />
      </label>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {visibleItems.length > 0 ? (
          groupSettingsNav(visibleItems, localizedGroups)
            .filter(({ items }) => items.length > 0)
            .map(({ group, items }) => (
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
          <p className="px-2 text-sm text-fg-muted">{t("settings.window.noSettingsMatch")}</p>
        )}
      </div>

      <div className="px-2 pt-3 pb-1 text-xs text-fg-faint">
        <div>{t("settings.window.appTitle")}</div>
        {version ? <div className="mt-1">v{version}</div> : null}
        <p className="mt-2 leading-snug" data-testid="model-attribution">
          {t("settings.window.modelAttribution")}
        </p>
      </div>
    </aside>
  );
}

/** The running app's version (main's app.getVersion()); undefined without the bridge. */
function useAppVersion(): string | undefined {
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    const request = window.modus?.app?.version;
    if (!request) return;
    let active = true;
    request()
      .then((value: string) => {
        if (active && value) setVersion(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return version;
}

function SettingsNavGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="mb-5">
      <h3 className="mb-1.5 px-2 text-[11px] font-medium text-fg-faint">{title}</h3>
      <div className="space-y-0.5">{children}</div>
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
        "flex h-8 w-full items-center gap-2 rounded-lg px-2 aria-[current=page]:font-medium text-left text-sm transition-colors",
        active ? "text-accent" : "text-fg-muted hover:text-fg",
      )}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      type="button"
    >
      <span className={active ? "text-accent" : "text-fg-subtle"}>{icon}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}
