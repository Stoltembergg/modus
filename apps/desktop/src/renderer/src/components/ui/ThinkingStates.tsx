/**
 * Thinking states — adapted from Transitions.dev
 * https://transitions.dev/transitions/thinking-states/
 *
 * Status line shimmers while it holds, then swaps to the next with
 * blur + vertical slide. Left-aligned for chrome; sizer grows to the
 * widest label seen so the timer beside it doesn't jump.
 */
import { useReducedMotion } from "motion/react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { MOTION_DURATION, MOTION_REDUCED_DURATION } from "../../lib/motion";

const SWAP_MS = Math.round(MOTION_DURATION.base * 1000);
/** Reduced motion: the same exit/enter swap, as a short cross-fade (CSS drops travel + blur). */
const REDUCED_SWAP_MS = Math.round(MOTION_REDUCED_DURATION * 1000);
const GAP_MS = 50;

export function ThinkingStates({ label, className }: { label: string; className?: string }) {
  const reduce = useReducedMotion();
  const swapMs = reduce ? REDUCED_SWAP_MS : SWAP_MS;
  const textRef = useRef<HTMLSpanElement>(null);
  const shownRef = useRef(label);
  const pendingRef = useRef<string | null>(null);
  const animatingRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const [sizer, setSizer] = useState(label);
  const [shown, setShown] = useState(label);

  useEffect(() => {
    setSizer((prev) => (label.length > prev.length ? label : prev));
  }, [label]);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;

    const clearTimers = (): void => {
      for (const id of timersRef.current) window.clearTimeout(id);
      timersRef.current = [];
    };

    const apply = (next: string): void => {
      shownRef.current = next;
      setShown(next);
      el.dataset.text = next;
    };

    const runSwap = (next: string): void => {
      if (next === shownRef.current) {
        animatingRef.current = false;
        return;
      }
      animatingRef.current = true;
      clearTimers();
      el.classList.remove("is-enter-start");
      el.classList.add("is-exit");

      const exitId = window.setTimeout(() => {
        apply(next);
        el.classList.remove("is-exit");
        el.classList.add("is-enter-start");
        void el.offsetWidth;
        const enterId = window.setTimeout(() => {
          el.classList.remove("is-enter-start");
          animatingRef.current = false;
          const queued = pendingRef.current;
          pendingRef.current = null;
          if (queued && queued !== shownRef.current) runSwap(queued);
        }, GAP_MS);
        timersRef.current = [enterId];
      }, swapMs);
      timersRef.current = [exitId];
    };

    if (label === shownRef.current) return;

    if (animatingRef.current) {
      pendingRef.current = label;
      return;
    }

    runSwap(label);

    return () => {
      // Don't cancel mid-swap on label churn — pending queue handles it.
      // Only clean up on unmount (detected via el disconnect in a separate effect).
    };
  }, [label, swapMs]);

  useEffect(() => {
    const el = textRef.current;
    return () => {
      for (const id of timersRef.current) window.clearTimeout(id);
      timersRef.current = [];
      animatingRef.current = false;
      pendingRef.current = null;
      el?.classList.remove("is-exit", "is-enter-start");
    };
  }, []);

  return (
    <span
      aria-hidden="true"
      className={cn("t-think", className)}
      style={
        {
          "--think-swap": `${swapMs}ms`,
          "--think-distance": "8px",
          "--think-blur": "2px",
          "--think-shimmer": "2s",
        } as CSSProperties
      }
    >
      <span className="t-think-sizer">{sizer}</span>
      <span className="t-think-text" data-text={shown} ref={textRef}>
        {shown}
      </span>
    </span>
  );
}
