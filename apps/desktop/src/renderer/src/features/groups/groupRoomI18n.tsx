import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  type GroupPluralTextBase,
  type GroupTextKey,
  type GroupTextVars,
  groupPluralText,
  groupText,
} from "../../../../shared/group-room-locale";

/**
 * Room locale for everything under `GroupRoom` (C6). `undefined` = the
 * renderer locale (`navigator.language`), the same rule as the catalog
 * (`resolveGroupRoomLocale`). A component's own `locale` prop still wins.
 */
const GroupRoomLocaleContext = createContext<string | null | undefined>(undefined);

export function GroupRoomLocaleProvider({
  locale,
  children,
}: {
  locale?: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <GroupRoomLocaleContext.Provider value={locale ?? undefined}>
      {children}
    </GroupRoomLocaleContext.Provider>
  );
}

/** `override` (a component prop) → the room provider → the renderer locale. */
export function useGroupRoomLocale(override?: string | null): string | undefined {
  const fromRoom = useContext(GroupRoomLocaleContext);
  return override ?? fromRoom ?? undefined;
}

export type GroupTextFn = {
  (key: GroupTextKey, vars?: GroupTextVars): string;
  plural: (base: GroupPluralTextBase, count: number, vars?: GroupTextVars) => string;
  locale: string | undefined;
};

/** `t(key, vars)` bound to the room locale; `t.plural(base, n)` for `_one`/`_other`. */
export function useGroupText(override?: string | null): GroupTextFn {
  const locale = useGroupRoomLocale(override);
  return useMemo(() => groupTextFor(locale), [locale]);
}

/** Same as `useGroupText`, outside React (plain helpers take a `locale` param). */
export function groupTextFor(locale?: string | null): GroupTextFn {
  const resolved = locale ?? undefined;
  const t = ((key: GroupTextKey, vars?: GroupTextVars) =>
    groupText(key, resolved, vars)) as GroupTextFn;
  t.plural = (base, count, vars) => groupPluralText(base, count, resolved, vars);
  t.locale = resolved;
  return t;
}
