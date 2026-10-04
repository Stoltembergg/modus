import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampLine, createLineFlash, LINE_FLASH_MS } from "./lineFlash";

describe("clampLine", () => {
  it("clamps a line beyond the end of the file to the last line", () => {
    expect(clampLine(500, 42)).toBe(42);
    expect(clampLine(42, 42)).toBe(42);
  });

  it("keeps a line in range and floors below 1 / non-finite to line 1", () => {
    expect(clampLine(7, 42)).toBe(7);
    expect(clampLine(0, 42)).toBe(1);
    expect(clampLine(-3, 42)).toBe(1);
    expect(clampLine(Number.NaN, 42)).toBe(1);
    expect(clampLine(3, 0)).toBe(1);
  });
});

describe("createLineFlash", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the highlight and fades it on its own", () => {
    const apply = vi.fn();
    const clear = vi.fn();
    const flash = createLineFlash({ apply, clear });
    flash.flash(12);
    expect(apply).toHaveBeenCalledWith(12);
    expect(flash.active()).toBe(true);
    vi.advanceTimersByTime(LINE_FLASH_MS - 1);
    expect(clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(flash.active()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-flashing the same line before the fade restarts it (not stuck, one timer)", () => {
    const apply = vi.fn();
    const clear = vi.fn();
    const flash = createLineFlash({ apply, clear });
    flash.flash(12);
    vi.advanceTimersByTime(LINE_FLASH_MS - 200);
    flash.flash(12);
    // The old highlight was dropped and re-applied; only one timer is pending.
    expect(clear).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    expect(flash.active()).toBe(true);
    // The first timer must not end the second highlight early.
    vi.advanceTimersByTime(200);
    expect(flash.active()).toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
    // A full duration from the re-flash, it fades.
    vi.advanceTimersByTime(LINE_FLASH_MS - 200);
    expect(flash.active()).toBe(false);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    // And it can be triggered again afterwards.
    flash.flash(12);
    expect(flash.active()).toBe(true);
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it("re-flashing many times in a row never leaks timers", () => {
    const clear = vi.fn();
    const flash = createLineFlash({ apply: vi.fn(), clear });
    for (let i = 0; i < 10; i += 1) {
      flash.flash(i + 1);
      vi.advanceTimersByTime(100);
    }
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(LINE_FLASH_MS);
    expect(flash.active()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose cancels the pending timer and clears the highlight once", () => {
    const clear = vi.fn();
    const flash = createLineFlash({ apply: vi.fn(), clear });
    flash.flash(3);
    flash.dispose();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(LINE_FLASH_MS * 2);
    expect(clear).toHaveBeenCalledTimes(1);
    flash.dispose();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
