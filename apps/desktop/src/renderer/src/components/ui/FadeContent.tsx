/**
 * Fade Content — adapted from React Bits (motion/react, mount-only; no ScrollTrigger)
 * https://reactbits.dev/animations/fade-content
 */
import { m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

export type FadeContentProps = {
  children: ReactNode;
  blur?: boolean;
  duration?: number;
  delay?: number;
  initialOpacity?: number;
  className?: string;
  onComplete?: () => void;
};

/** Treat values > 10 as milliseconds (React Bits convention). */
const toSeconds = (val: number) => (val > 10 ? val / 1000 : val);

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export function FadeContent({
  children,
  blur = false,
  duration = 0.7,
  delay = 0,
  initialOpacity = 0,
  className = "",
  onComplete,
}: FadeContentProps) {
  const reduce = useReducedMotion();
  const seconds = toSeconds(duration);
  const delaySeconds = toSeconds(delay);

  return (
    <m.div
      className={className}
      initial={
        reduce
          ? false
          : {
              opacity: initialOpacity,
              filter: blur ? "blur(10px)" : "blur(0px)",
            }
      }
      // Keep the post-animation value as `none`: even blur(0px) establishes a
      // backdrop root and prevents nested glass surfaces from sampling native
      // window vibrancy behind this wrapper.
      animate={{ opacity: 1, filter: "none" }}
      transition={{
        duration: reduce ? 0 : seconds,
        delay: reduce ? 0 : delaySeconds,
        ease: EASE_OUT,
      }}
      onAnimationComplete={() => onComplete?.()}
    >
      {children}
    </m.div>
  );
}
