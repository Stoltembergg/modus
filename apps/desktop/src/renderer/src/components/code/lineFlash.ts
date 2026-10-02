/**
 * Target-line flash for the code editor (C2.1): centre + cursor are done by the
 * caller; this owns the short highlight. A new flash before the previous one
 * faded clears it and restarts (never stuck, never two timers), and dispose()
 * cancels the pending timer and clears the highlight.
 */
export const LINE_FLASH_MS = 1600;

/** A line beyond the file opens at the last line; below 1 opens at line 1. */
export function clampLine(line: number, lineCount: number): number {
  const last = Math.max(1, Math.floor(lineCount));
  if (!Number.isFinite(line)) return 1;
  return Math.min(Math.max(1, Math.floor(line)), last);
}

export type LineFlash = {
  flash(line: number): void;
  dispose(): void;
  /** True while a highlight is shown (tests / diagnostics). */
  active(): boolean;
};

export function createLineFlash(input: {
  apply(line: number): void;
  clear(): void;
  durationMs?: number;
}): LineFlash {
  const duration = input.durationMs ?? LINE_FLASH_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shown = false;

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (shown) {
      shown = false;
      input.clear();
    }
  };

  return {
    flash(line) {
      // Restart: drop the previous highlight first so it re-renders (and the
      // CSS fade starts over) instead of extending a stale one.
      stop();
      input.apply(line);
      shown = true;
      timer = setTimeout(() => {
        timer = undefined;
        shown = false;
        input.clear();
      }, duration);
    },
    dispose: stop,
    active: () => shown,
  };
}
