import { useMemo } from "react";
import { type ShellTextKey, shellText } from "../../../shared/shell-text";

export type ShellTextFn = (key: ShellTextKey) => string;

/** App shell copy bound to a locale. No locale = English, like the other catalogs. */
export function useShellText(locale?: string | null): ShellTextFn {
  return useMemo(() => (key: ShellTextKey) => shellText(key, locale), [locale]);
}
