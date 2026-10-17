/**
 * App language (v0.1.11 language selector), shared by main, preload and renderer.
 *
 * The user picks "system" or one of the languages that ship a complete UI
 * catalog (Settings + app shell + native menu / dialogs). The default is
 * English (C6.2) until the whole app is translated, so a first run never opens
 * a half-translated window; "system" is opt-in.
 * "system" maps the OS preferred languages to that list by language with a
 * region fallback: pt-PT → pt-BR when there is no pt-PT catalog, en-GB → en,
 * anything unknown → en.
 *
 * The renderer applies the result as `<html lang>` (the BCP-47 tag `Intl`
 * uses too), so every catalog hook and every date / number formatter follows
 * it without a restart.
 */

export type UiLanguageId = "en" | "pt-BR";
export type UiLanguagePreference = "system" | UiLanguageId;

export type UiLanguageOption = {
  id: UiLanguageId;
  /** Shown in its own language, never translated into the current UI language. */
  nativeName: string;
  /** `Intl` tag used when the OS region does not apply (explicit choice, or another region). */
  intlLocale: string;
};

/**
 * Languages with a full translation. zh has partial catalogs (group room,
 * shell) but no Settings or native-menu copy yet, so it is not offered: a
 * Chinese UI would show whole English screens.
 */
export const UI_LANGUAGES: readonly UiLanguageOption[] = [
  { id: "en", nativeName: "English", intlLocale: "en-US" },
  { id: "pt-BR", nativeName: "Português (Brasil)", intlLocale: "pt-BR" },
];

export const DEFAULT_UI_LANGUAGE_PREFERENCE: UiLanguagePreference = "en";
export const FALLBACK_UI_LANGUAGE: UiLanguageId = "en";

export const UI_LANGUAGE_PREFERENCES: readonly UiLanguagePreference[] = [
  "system",
  ...UI_LANGUAGES.map((language) => language.id),
];

export type UiLanguageState = {
  preference: UiLanguagePreference;
  /** Catalog language in use. */
  language: UiLanguageId;
  /** BCP-47 tag for `<html lang>` and `Intl` (keeps the OS region under "system": en-GB, pt-PT). */
  intlLocale: string;
  /** OS preferred languages as reported by the OS, most preferred first. */
  systemLocales: string[];
};

function canonical(tag: string): string | undefined {
  const raw = tag.trim().replace(/_/g, "-");
  if (!raw) return undefined;
  try {
    return Intl.getCanonicalLocales(raw)[0];
  } catch {
    return undefined;
  }
}

function languageOf(tag: string): string {
  return tag.split("-")[0]?.toLowerCase() ?? "";
}

export function isUiLanguagePreference(value: unknown): value is UiLanguagePreference {
  return (
    typeof value === "string" && (UI_LANGUAGE_PREFERENCES as readonly string[]).includes(value)
  );
}

export function uiLanguageOption(id: UiLanguageId): UiLanguageOption {
  return (
    UI_LANGUAGES.find((language) => language.id === id) ?? (UI_LANGUAGES[0] as UiLanguageOption)
  );
}

/**
 * Map OS preferred languages to a shipped language. Each OS entry is tried in
 * order: an exact match wins, then the same language in another region.
 * The first OS entry that matches anything decides; none → English.
 */
export function matchSystemLanguage(systemLocales: readonly string[]): {
  language: UiLanguageId;
  /** The OS tag that decided, canonicalised, when it matched. */
  osTag?: string;
} {
  for (const entry of systemLocales) {
    const tag = canonical(entry);
    if (!tag) continue;
    const exact = UI_LANGUAGES.find((language) => language.id.toLowerCase() === tag.toLowerCase());
    if (exact) return { language: exact.id, osTag: tag };
    const sameLanguage = UI_LANGUAGES.find(
      (language) => languageOf(language.id) === languageOf(tag),
    );
    if (sameLanguage) return { language: sameLanguage.id, osTag: tag };
  }
  return { language: FALLBACK_UI_LANGUAGE };
}

/**
 * The first OS entry in the given language, canonicalised (en-GB for an en-GB
 * user who picked English), so an explicit choice still keeps the OS region.
 */
function osTagForLanguage(id: UiLanguageId, systemLocales: readonly string[]): string | undefined {
  for (const entry of systemLocales) {
    const tag = canonical(entry);
    if (tag && languageOf(tag) === languageOf(id)) return tag;
  }
  return undefined;
}

/**
 * Resolve the preference against the OS. The `Intl` tag keeps the OS region
 * whenever the OS lists the same language (en-GB dates for an en-GB user, under
 * "system" or with "English" picked); otherwise it is the language's own tag.
 */
export function resolveUiLanguage(
  preference: UiLanguagePreference,
  systemLocales: readonly string[],
): UiLanguageState {
  const locales = [...systemLocales];
  if (preference !== "system") {
    return {
      preference,
      language: preference,
      intlLocale: osTagForLanguage(preference, locales) ?? uiLanguageOption(preference).intlLocale,
      systemLocales: locales,
    };
  }
  const { language, osTag } = matchSystemLanguage(locales);
  return {
    preference,
    language,
    intlLocale: osTag ?? uiLanguageOption(language).intlLocale,
    systemLocales: locales,
  };
}
