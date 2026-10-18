import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import {
  layoutSnap,
  MOTION_DURATION,
  MOTION_EASE,
  motionOffset,
  reducedFade,
} from "../../lib/motion";

type CollapsibleMotionPreset = "default" | "compact" | "timeline";

/**
 * Slightly deliberate expand/collapse — short snappy times feel abrupt in panels.
 * Built on the emphasized duration (280ms) plus a per-preset extra.
 */
const COLLAPSIBLE_MOTION = {
  compact: MOTION_DURATION.emphasized + 0.02,
  default: MOTION_DURATION.emphasized + 0.06,
  timeline: MOTION_DURATION.emphasized + 0.08,
} satisfies Record<CollapsibleMotionPreset, number>;

export function CollapsibleMotion({
  children,
  className,
  id,
  open,
  preset = "default",
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  open: boolean;
  preset?: CollapsibleMotionPreset;
}) {
  const reduceMotion = useReducedMotion();
  const duration = COLLAPSIBLE_MOTION[preset];
  // Reduced motion: height snaps open/closed, the content still fades (120ms).
  const outer = reduceMotion
    ? { ...reducedFade, height: layoutSnap }
    : { duration, ease: MOTION_EASE.gentle };
  const inner = reduceMotion
    ? reducedFade
    : { duration: duration * 0.9, ease: MOTION_EASE.standard };

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <m.div
          animate={{ height: "auto", opacity: 1 }}
          className={cn("relative overflow-hidden", className)}
          data-collapsible-motion
          exit={{ height: 0, opacity: 0 }}
          id={id}
          initial={{ height: 0, opacity: 0 }}
          key="open"
          style={{ transformOrigin: "top" }}
          transition={outer}
        >
          <m.div
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: motionOffset(-6, reduceMotion) }}
            initial={{ opacity: 0, y: motionOffset(-6, reduceMotion) }}
            transition={inner}
          >
            {children}
          </m.div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
