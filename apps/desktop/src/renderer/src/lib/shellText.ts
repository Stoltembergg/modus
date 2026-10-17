import { useMemo } from "react";
import { type ShellTextKey, type ShellTextVars, shellText } from "../../../shared/shell-text";
import { useUiLocale } from "./uiLocale";

export type ShellTextFn = (key: ShellTextKey, vars?: ShellTextVars) => string;

/** App shell copy bound to `override` or the app language (`<html lang>`); neither = English. */
export function useShellText(override?: string | null): ShellTextFn {
  const uiLocale = useUiLocale();
  const locale = override ?? uiLocale;
  return useMemo(
    () => (key: ShellTextKey, vars?: ShellTextVars) => shellText(key, locale, vars),
    [locale],
  );
}
