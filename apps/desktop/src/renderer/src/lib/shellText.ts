import { useMemo } from "react";
import { type ShellTextKey, type ShellTextVars, shellText } from "../../../shared/shell-text";

export type ShellTextFn = (key: ShellTextKey, vars?: ShellTextVars) => string;

/** App shell copy bound to a locale. No locale = English, like the other catalogs. */
export function useShellText(locale?: string | null): ShellTextFn {
  return useMemo(
    () => (key: ShellTextKey, vars?: ShellTextVars) => shellText(key, locale, vars),
    [locale],
  );
}
