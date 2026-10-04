import {
  IconBlur,
  IconDeviceDesktop,
  IconLayoutSidebar,
  IconMoon,
  IconMoonStars,
  IconSquare,
  IconSun,
} from "@tabler/icons-react";
import type { AppearanceState, TransparencyPreference } from "../../../../../shared/appearance";
import { setTransparency, useAppearanceState } from "../../../lib/appearance";
import { cn } from "../../../lib/cn";
import { type ThemeMode, useTheme } from "../../../lib/theme";
import {
  ReadOnlyPill,
  SettingsList,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "../settings-layout";

export function AppearanceSettingsPanel() {
  const [theme, setTheme] = useTheme();
  const appearance = useAppearanceState();
  return (
    <>
      <SettingsPageHeader
        description="Visual preferences aligned with the current Modus desktop theme."
        title="Appearance"
      />
      <SettingsSection title="Theme">
        <SettingsList>
          <SettingsRow
            control={
              <Segmented label="theme" onChange={setTheme} options={THEME_OPTIONS} value={theme} />
            }
            description="Follow your system appearance or choose a light, dark, or eye-care palette."
            title="Color scheme"
          />
          <SettingsRow
            control={
              <Segmented
                disabled={!appearance || appearance.blockedBy === "platform"}
                label="transparency"
                onChange={setTransparency}
                options={TRANSPARENCY_OPTIONS}
                value={appearance?.transparency ?? "sidebar"}
              />
            }
            description={transparencyDescription(appearance)}
            title="Transparency"
          />
          <SettingsRow
            control={<ReadOnlyPill>Inter + Noto SC</ReadOnlyPill>}
            description="Self-hosted Inter Variable (Latin) and Noto Sans SC Variable (CJK); system faces only cover gaps."
            title="Font family"
          />
        </SettingsList>
      </SettingsSection>
    </>
  );
}

/** Row description: why the app is solid despite Full/Sidebar, or what the modes do. */
export function transparencyDescription(appearance: AppearanceState | null): string {
  switch (appearance?.blockedBy) {
    case undefined:
    case "platform":
      return "Translucent window materials are not available on this system.";
    case "os-reduced-transparency":
      return "Solid while Reduce transparency is on in your system settings.";
    case "os-high-contrast":
      return "Solid while a high-contrast system setting is on.";
    default:
      return "Let the desktop show through the sidebar only, the whole app, or nothing. Same in every theme.";
  }
}

type SegmentOption<T extends string> = { value: T; label: string; icon: typeof IconSun };

const THEME_OPTIONS: ReadonlyArray<SegmentOption<ThemeMode>> = [
  { value: "system", label: "System", icon: IconDeviceDesktop },
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
  { value: "dark-plus", label: "Eye-care Dark", icon: IconMoonStars },
];

const TRANSPARENCY_OPTIONS: ReadonlyArray<SegmentOption<TransparencyPreference>> = [
  { value: "full", label: "Full", icon: IconBlur },
  { value: "sidebar", label: "Sidebar", icon: IconLayoutSidebar },
  { value: "off", label: "Off", icon: IconSquare },
];

function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  disabled = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentOption<T>>;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-lg border border-hairline-soft bg-canvas p-0.5",
        disabled && "opacity-50",
      )}
    >
      {options.map(({ value: option, label: optionLabel, icon: Icon }) => {
        const active = option === value;
        return (
          <button
            aria-pressed={active}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed",
              active ? "bg-active text-fg shadow-composer" : "text-fg-subtle hover:text-fg-muted",
            )}
            disabled={disabled}
            key={option}
            onClick={() => onChange(option)}
            title={`${optionLabel} ${label}`}
            type="button"
          >
            <Icon size={14} stroke={1.8} />
            {optionLabel}
          </button>
        );
      })}
    </div>
  );
}
