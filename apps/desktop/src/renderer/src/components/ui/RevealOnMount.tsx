import { m, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";

const ENTER_OFFSET_PX = 6;
const ENTER_DURATION_S = 0.24;

type RevealOnMountProps = {
  children: ReactNode;
  /**
   * Whether this block arrived during the live session. Read once, at mount: blocks
   * that already existed when the chat opened pass `false` and never animate, and a
   * later change of the prop does not replay (or remount) anything.
   */
  animate: boolean;
  className?: string | undefined;
};

/**
 * One-shot entrance for a timeline block: opacity 0→1 plus a few px of upward travel,
 * ease-out, ~240 ms. No IntersectionObserver, no blur/filter (a filter would create a
 * backdrop root and break the native glass). Reduced motion renders the final state.
 */
export function RevealOnMount({ children, animate, className }: RevealOnMountProps) {
  const reduceMotion = useReducedMotion() ?? false;
  // Frozen at mount so the wrapper element never swaps type (which would remount children).
  const [play] = useState(() => animate && !reduceMotion);

  if (!play) {
    return (
      <div className={className} data-reveal="static">
        {children}
      </div>
    );
  }
  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      className={className}
      data-reveal="enter"
      initial={{ opacity: 0, y: ENTER_OFFSET_PX }}
      transition={{ duration: ENTER_DURATION_S, ease: "easeOut" }}
    >
      {children}
    </m.div>
  );
}
