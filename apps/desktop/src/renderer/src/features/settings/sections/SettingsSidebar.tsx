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
        <SettingsNavGroup title="Personal">
          <SettingsNavItem
            active={activeSection === "general"}
            icon={<IconSettings size={16} stroke={1.7} />}
            onClick={() => onSectionChange("general")}
          >
            General
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "model-provider"}
            icon={<IconServerCog size={16} stroke={1.7} />}
            onClick={() => onSectionChange("model-provider")}
          >
            Model & Provider
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "appearance"}
            icon={<IconPalette size={16} stroke={1.7} />}
            onClick={() => onSectionChange("appearance")}
          >
            Appearance
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "personalization"}
            icon={<IconUser size={16} stroke={1.7} />}
            onClick={() => onSectionChange("personalization")}
          >
            Personalization
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "project-memory"}
            icon={<IconBrain size={16} stroke={1.7} />}
            onClick={() => onSectionChange("project-memory")}
          >
            Project memory
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "harness-insights"}
            icon={<IconBulb size={16} stroke={1.7} />}
            onClick={() => onSectionChange("harness-insights")}
          >
            Harness Insights
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "mcp"}
            icon={<IconPlugConnected size={16} stroke={1.7} />}
            onClick={() => onSectionChange("mcp")}
          >
            MCP
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "skills"}
            icon={<IconCube size={16} stroke={1.7} />}
            onClick={() => onSectionChange("skills")}
          >
            Skills
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "subagents"}
            icon={<IconUser size={16} stroke={1.7} />}
            onClick={() => onSectionChange("subagents")}
          >
            Subagents
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "rules"}
            icon={<IconGavel size={16} stroke={1.7} />}
            onClick={() => onSectionChange("rules")}
          >
            Rules
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "limits"}
            icon={<IconGauge size={16} stroke={1.7} />}
            onClick={() => onSectionChange("limits")}
          >
            Limits
          </SettingsNavItem>
        </SettingsNavGroup>
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
