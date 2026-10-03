import { vi } from "vitest";

/**
 * Test helper (C6.2): pretend the OS locale is `tag`. `navigator.language`
 * returns it, and every `Intl.DateTimeFormat` / `Date#toLocale*String` call
 * that asks for the runtime default (no tag or `[]`) gets `tag` instead.
 * Explicit tags pass through untouched. Returns a restore function (also
 * undone by `vi.restoreAllMocks()` for the spies; call it for `Intl`).
 */
export function simulateSystemLocale(tag: string): () => void {
  const isDefault = (locales: unknown) =>
    locales === undefined || (Array.isArray(locales) && locales.length === 0);
  const pick = (locales: Intl.LocalesArgument | undefined) => (isDefault(locales) ? tag : locales);

  vi.spyOn(navigator, "language", "get").mockReturnValue(tag);

  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  class Simulated extends OriginalDateTimeFormat {
    constructor(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      super(pick(locales), options);
    }
  }
  Intl.DateTimeFormat = Simulated as typeof Intl.DateTimeFormat;

  type ToLocale = (this: Date, locales?: Intl.LocalesArgument, options?: object) => string;
  for (const name of ["toLocaleTimeString", "toLocaleDateString", "toLocaleString"] as const) {
    const original = Date.prototype[name] as ToLocale;
    vi.spyOn(Date.prototype, name).mockImplementation(function (
      this: Date,
      locales?: Intl.LocalesArgument,
      options?: object,
    ) {
      return original.call(this, pick(locales), options);
    } as ToLocale);
  }

  return () => {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  };
}
