/**
 * Per-key English fallback shared by the UI catalogs. A key missing from (or
 * empty in) the active locale's table falls back to English for that key
 * only, so an incomplete translation never turns a whole screen English.
 * The parity tests keep shipped tables complete; this is the runtime guard.
 */
export function lookupCatalogText<Key extends string>(
  english: Readonly<Record<Key, string>>,
  localized: Readonly<Partial<Record<Key, string>>> | undefined,
  key: Key,
): string {
  const value = localized?.[key];
  if (typeof value === "string" && value !== "") return value;
  return english[key] ?? key;
}

export type CatalogVars = Readonly<Record<string, string | number>>;

/** Fill `{name}` placeholders; unknown names stay as written. */
export function fillCatalogText(template: string, vars?: CatalogVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
