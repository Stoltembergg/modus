import { useMemo } from "react";
import {
  type FilesSearchPluralBase,
  type FilesSearchTextKey,
  filesSearchPluralText,
  filesSearchText,
  type GroupTextVars,
} from "../../../../shared/group-room-locale";
import { useGroupRoomLocale } from "../groups/groupRoomI18n";

/**
 * Files panel / Search Tool card copy (C6.1). Same locale source as the room
 * (C6): an explicit `locale` prop wins, then the enclosing room's locale (when
 * rendered inside a group room), else English (C6.2: never the system locale).
 */
export type FilesTextFn = {
  (key: FilesSearchTextKey, vars?: GroupTextVars): string;
  plural: (base: FilesSearchPluralBase, count: number, vars?: GroupTextVars) => string;
  locale: string | undefined;
};

export function filesTextFor(locale?: string | null): FilesTextFn {
  const resolved = locale ?? undefined;
  const t = ((key: FilesSearchTextKey, vars?: GroupTextVars) =>
    filesSearchText(key, resolved, vars)) as FilesTextFn;
  t.plural = (base, count, vars) => filesSearchPluralText(base, count, resolved, vars);
  t.locale = resolved;
  return t;
}

export function useFilesText(override?: string | null): FilesTextFn {
  const locale = useGroupRoomLocale(override);
  return useMemo(() => filesTextFor(locale), [locale]);
}
