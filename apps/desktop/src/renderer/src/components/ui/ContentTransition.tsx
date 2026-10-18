import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { motionOffset, swapTransition, tween } from "../../lib/motion";

type ContentTransitionProps = {
  children: ReactNode;
  className?: string;
  transitionKey: string;
};

const DISTANCE = 4;
const TRANSITION = tween("base");

/**
 * Fade-out-then-in swap keyed by `transitionKey`. Under reduced motion both
 * halves use `reducedSwapFade`, so the whole swap is one 120ms fade.
 */
export function ContentTransition({ children, className, transitionKey }: ContentTransitionProps) {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false} mode="wait">
      <m.div
        animate={{ opacity: 1, y: 0 }}
        className={className}
        exit={{ opacity: 0, y: motionOffset(-2, reduceMotion) }}
        initial={{ opacity: 0, y: motionOffset(DISTANCE, reduceMotion) }}
        key={transitionKey}
        transition={swapTransition(TRANSITION, reduceMotion)}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}
