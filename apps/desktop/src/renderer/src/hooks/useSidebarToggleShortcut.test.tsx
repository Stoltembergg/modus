// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it } from "vitest";
import { isSidebarToggleShortcut, useSidebarToggleShortcut } from "./useSidebarToggleShortcut";

function press(init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ...init }));
  });
}

function useSidebar(isMac: boolean) {
  const [open, setOpen] = useState(true);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  useSidebarToggleShortcut(toggle, isMac);
  return open;
}

describe("sidebar toggle shortcut", () => {
  it("Cmd+B closes and reopens the sidebar on macOS", () => {
    const { result } = renderHook(() => useSidebar(true));
    press({ metaKey: true });
    expect(result.current).toBe(false);
    press({ metaKey: true });
    expect(result.current).toBe(true);
    press({ ctrlKey: true });
    expect(result.current).toBe(true);
  });

  it("Ctrl+B toggles elsewhere and ignores Cmd+B", () => {
    const { result } = renderHook(() => useSidebar(false));
    press({ ctrlKey: true });
    expect(result.current).toBe(false);
    press({ metaKey: true });
    expect(result.current).toBe(false);
    press({ ctrlKey: true });
    expect(result.current).toBe(true);
  });

  it("ignores Shift/Alt variants and other keys", () => {
    const base = { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isSidebarToggleShortcut({ ...base, key: "B" }, true)).toBe(true);
    expect(isSidebarToggleShortcut({ ...base, key: "b", shiftKey: true }, true)).toBe(false);
    expect(isSidebarToggleShortcut({ ...base, key: "b", altKey: true }, true)).toBe(false);
    expect(isSidebarToggleShortcut({ ...base, key: "k" }, true)).toBe(false);
  });
});
