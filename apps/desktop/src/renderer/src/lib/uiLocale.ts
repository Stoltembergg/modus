import { useSyncExternalStore } from "react";

/**
 * UI text locale = the document language (`<html lang>`). index.html ships
 * `lang="en"` and nothing changes it yet, so the UI stays English (C6.2); a
 * future language selector only has to set `document.documentElement.lang`
 * and every component that reads this hook re-renders in that language.
 */
export function readUiLocale(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.documentElement.lang || undefined;
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  return () => observer.disconnect();
}

export function useUiLocale(): string | undefined {
  return useSyncExternalStore(subscribe, readUiLocale, readUiLocale);
}
