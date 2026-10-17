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
import type { SettingsTextKey } from "../../../../../shared/settings-text";
import { setTransparency, useAppearanceState } from "../../../lib/appearance";
import { cn } from "../../../lib/cn";
import { type SettingsTextFn, settingsTextFor, useSettingsText } from "../../../lib/settingsText";
import { type ThemeMode, useTheme } from "../../../lib/theme";
import { Disclosure } from "../form-controls";
import {
  ReadOnlyPill,
  SettingsList,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "../settings-layout";

export function AppearanceSettingsPanel() {
  const t = useSettingsText();
  const [theme, setTheme] = useTheme();
  const appearance = useAppearanceState();
  // Eye-care Dark belonged to the removed classic look; a stored one shows as Dark.
  const themeOptions = THEME_OPTIONS.filter((option) => option.value !== "dark-plus");
  const themeValue = theme === "dark-plus" ? "dark" : theme;

  return (
    <>
      <SettingsPageHeader title={t("settings.appearance.title")} />
      <SettingsSection title={t("settings.appearance.theme")}>
        <SettingsList>
          <SettingsRow
            control={
              <Segmented
                label={t("settings.appearance.theme")}
                onChange={(next) => {
                  // Under New a stored Eye-care Dark shows as Dark: re-picking it must not erase it.
                  if (next !== themeValue) setTheme(next);
                }}
                options={themeOptions}
                value={themeValue}
              />
            }
            title={t("settings.appearance.colorScheme")}
          />
          <SettingsRow
            control={
              <Segmented
                disabled={!appearance || appearance.blockedBy === "platform"}
                label={t("settings.appearance.transparency")}
                onChange={setTransparency}
                options={TRANSPARENCY_OPTIONS}
                value={appearance?.transparency ?? "sidebar"}
              />
            }
            description={transparencyDescription(appearance, t)}
            title={t("settings.appearance.transparency")}
          />
        </SettingsList>
      </SettingsSection>
      <Disclosure label={t("settings.appearance.fontDetails")}>
        <SettingsList>
          <SettingsRow
            control={<ReadOnlyPill>{t("settings.appearance.fontFamilyValue")}</ReadOnlyPill>}
            description={t("settings.appearance.fontFamilyDescription")}
            title={t("settings.appearance.fontFamily")}
          />
        </SettingsList>
      </Disclosure>
    </>
  );
}

/** Row description: why the app is solid despite Full/Sidebar, or what the modes do. */
export function transparencyDescription(
  appearance: AppearanceState | null,
  t: SettingsTextFn = settingsTextFor(),
): string {
  switch (appearance?.blockedBy) {
    case undefined:
    case "platform":
      return t("settings.appearance.transparencyPlatformBlocked");
    case "os-reduced-transparency":
      return t("settings.appearance.transparencyBlockedReducedTransparency");
    case "os-high-contrast":
      return t("settings.appearance.transparencyBlockedHighContrast");
    default:
      return t("settings.appearance.transparencyDescription");
  }
}

type SegmentOption<T extends string> = {
  value: T;
  labelKey: SettingsTextKey;
  titleKey: SettingsTextKey;
  icon: typeof IconSun;
};

const THEME_OPTIONS: ReadonlyArray<SegmentOption<ThemeMode>> = [
  {
    value: "system",
    labelKey: "settings.appearance.themeSystem",
    titleKey: "settings.appearance.themeSystemTitle",
    icon: IconDeviceDesktop,
  },
  {
    value: "light",
    labelKey: "settings.appearance.themeLight",
    titleKey: "settings.appearance.themeLightTitle",
    icon: IconSun,
  },
  {
    value: "dark",
    labelKey: "settings.appearance.themeDark",
    titleKey: "settings.appearance.themeDarkTitle",
    icon: IconMoon,
  },
  {
    value: "dark-plus",
    labelKey: "settings.appearance.themeEyeCare",
    titleKey: "settings.appearance.themeEyeCareTitle",
    icon: IconMoonStars,
  },
];

const TRANSPARENCY_OPTIONS: ReadonlyArray<SegmentOption<TransparencyPreference>> = [
  {
    value: "full",
    labelKey: "settings.appearance.transparencyFull",
    titleKey: "settings.appearance.transparencyFullTitle",
    icon: IconBlur,
  },
  {
    value: "sidebar",
    labelKey: "settings.appearance.transparencySidebar",
    titleKey: "settings.appearance.transparencySidebarTitle",
    icon: IconLayoutSidebar,
  },
  {
    value: "off",
    labelKey: "settings.appearance.transparencyOff",
    titleKey: "settings.appearance.transparencyOffTitle",
    icon: IconSquare,
  },
];

function Segmented<T extends string>({
  value,
  onChange,
  options,
  label: _label,
  disabled = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentOption<T>>;
  label?: string;
  disabled?: boolean;
}) {
  const t = useSettingsText();
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-lg border border-hairline-soft bg-canvas p-0.5",
        disabled && "opacity-50",
      )}
    >
      {options.map(({ value: option, labelKey, titleKey, icon: Icon }) => {
        const active = option === value;
        const optionLabel = t(labelKey);
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
            title={t(titleKey)}
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
