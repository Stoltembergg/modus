import { IconDeviceDesktop, IconMoon, IconMoonStars, IconSun } from "@tabler/icons-react";
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
  return (
    <>
      <SettingsPageHeader
        description="Visual preferences aligned with the current Modus desktop theme."
        title="Appearance"
      />
      <SettingsSection title="Theme">
        <SettingsList>
          <SettingsRow
            control={<ThemeToggle onChange={setTheme} value={theme} />}
            description="Follow your system appearance or choose a light, dark, or eye-care palette."
            title="Color scheme"
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
const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; icon: typeof IconSun }> = [
  { value: "system", label: "System", icon: IconDeviceDesktop },
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
  { value: "dark-plus", label: "Eye-care Dark", icon: IconMoonStars },
];

function ThemeToggle({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-hairline-soft bg-canvas p-0.5">
      {THEME_OPTIONS.map(({ value: option, label, icon: Icon }) => {
        const active = option === value;
        return (
          <button
            aria-pressed={active}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              active ? "bg-active text-fg shadow-composer" : "text-fg-subtle hover:text-fg-muted",
            )}
            key={option}
            onClick={() => onChange(option)}
            title={`${label} theme`}
            type="button"
          >
            <Icon size={14} stroke={1.8} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
