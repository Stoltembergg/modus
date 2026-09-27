export type UpdateTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const UPDATE_INITIAL_DELAY_MS = 15_000;
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * Runs `tick` once after `initialDelayMs` (so the check does not compete with boot)
 * and then every `intervalMs`, measured from the end of the previous tick, so ticks
 * can never overlap.
 */
export function createUpdateScheduler(options: {
  timers: UpdateTimers;
  tick: () => Promise<void>;
  initialDelayMs?: number;
  intervalMs?: number;
}) {
  const initialDelayMs = options.initialDelayMs ?? UPDATE_INITIAL_DELAY_MS;
  const intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  let handle: unknown;
  let running = false;

  const schedule = (ms: number) => {
    handle = options.timers.setTimeout(() => {
      handle = undefined;
      void options
        .tick()
        .catch(() => undefined)
        .finally(() => {
          if (running) schedule(intervalMs);
        });
    }, ms);
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule(initialDelayMs);
    },
    stop() {
      running = false;
      if (handle !== undefined) options.timers.clearTimeout(handle);
      handle = undefined;
    },
    isRunning: () => running,
  };
}
