import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { motionOffset, motionTransition, tween } from "../../lib/motion";

type ContentTransitionProps = {
  children: ReactNode;
  className?: string;
  transitionKey: string;
};

const DISTANCE = 4;
const TRANSITION = tween("base");

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
        transition={motionTransition(TRANSITION, reduceMotion)}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}
