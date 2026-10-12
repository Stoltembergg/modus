import { useEffect, useRef, useState } from "react";

/**
 * Holds each value on screen for at least `minMs` so a fast stream of changes
 * (tool hops, thinking ↔ tool) doesn't flicker. The latest value always lands.
 */
export function useThrottledValue<T>(value: T, minMs: number): T {
  const [shown, setShown] = useState(value);
  const lastChange = useRef(Date.now());
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = lastChange.current + minMs - Date.now();
    const apply = () => {
      lastChange.current = Date.now();
      setShown(value);
    };
    if (wait <= 0) {
      apply();
      return;
    }
    const timer = window.setTimeout(apply, wait);
    return () => window.clearTimeout(timer);
  }, [value, shown, minMs]);
  return shown;
}
