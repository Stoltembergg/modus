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
import { type SettingsTextFn, settingsTextFor, useSettingsText } from "../../../lib/settingsText";
import { type ThemeMode, useTheme } from "../../../lib/theme";
import { Disclosure, SettingsSegmented } from "../form-controls";
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
            notice={transparencyNotice(appearance, t)}
            title={t("settings.appearance.transparency")}
          />
        </SettingsList>
      </SettingsSection>
      <Disclosure label={t("settings.appearance.fontDetails")}>
        <SettingsList>
          <SettingsRow
            control={<ReadOnlyPill>{t("settings.appearance.fontFamilyValue")}</ReadOnlyPill>}
            title={t("settings.appearance.fontFamily")}
          />
        </SettingsList>
      </Disclosure>
    </>
  );
}

/** Row notice, only when the OS or platform keeps the window solid (the options are blocked). */
export function transparencyNotice(
  appearance: AppearanceState | null,
  t: SettingsTextFn = settingsTextFor(),
): string | undefined {
  switch (appearance?.blockedBy) {
    case undefined:
    case "platform":
      return t("settings.appearance.transparencyPlatformBlocked");
    case "os-reduced-transparency":
      return t("settings.appearance.transparencyBlockedReducedTransparency");
    case "os-high-contrast":
      return t("settings.appearance.transparencyBlockedHighContrast");
    default:
      return undefined;
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
  label,
  disabled = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentOption<T>>;
  label: string;
  disabled?: boolean;
}) {
  const t = useSettingsText();
  return (
    <SettingsSegmented
      disabled={disabled}
      label={label}
      onChange={onChange}
      options={options.map(({ value: option, labelKey, titleKey, icon: Icon }) => ({
        value: option,
        label: t(labelKey),
        title: t(titleKey),
        icon: <Icon size={14} stroke={1.8} />,
      }))}
      value={value}
    />
  );
}
