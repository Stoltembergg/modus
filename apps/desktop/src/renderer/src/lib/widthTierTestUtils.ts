/**
 * Test helper (L3c): a ResizeObserver stand-in that reports a fixed width for every
 * observed element, so `useWidthTier` picks a tier in happy-dom (which has no layout).
 */
export function installFixedWidthResizeObserver(width: number): () => void {
  const previous = globalThis.ResizeObserver;
  class FixedWidthResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [{ contentRect: { width }, target } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = FixedWidthResizeObserver as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = previous;
  };
}
