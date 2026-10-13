import { useEffect } from "react";

/** Cmd+B on macOS, Ctrl+B elsewhere; no Shift/Alt so other bindings stay free. */
export function isSidebarToggleShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  isMac: boolean,
): boolean {
  if (event.key.toLowerCase() !== "b" || event.shiftKey || event.altKey) return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Keyboard path to open/close the sidebar now that the top-bar toggle is gone. */
export function useSidebarToggleShortcut(toggle: () => void, isMac: boolean): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || !isSidebarToggleShortcut(event, isMac)) return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle, isMac]);
}
