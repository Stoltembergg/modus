import { useReducedMotion } from "motion/react";
import { cn } from "../../lib/cn";

type WorkingTextProps = {
  children: string;
  className?: string | undefined;
  /** Freeze the sweep: static text in the normal colour, no transparent fill. */
  paused?: boolean | undefined;
};

/**
 * The app's "working" text signal. Renders in the subtle colour (`.working-text`, a
 * component-layer default that a caller's `text-*` utility overrides) with a light band
 * sweeping left → right, then a short pause. The band is a gradient over `currentColor`
 * clipped to the glyphs, so it follows light/dark and any caller colour; the dimmest
 * point keeps ~55% of the colour so the text stays readable mid-sweep.
 * Reduced motion: no moving gradient; the text breathes in opacity instead
 * (`working-text--pulse`). Paused: plain text, no gradient, no transparent fill.
 */
export function WorkingText({ children, className, paused = false }: WorkingTextProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const mode = paused ? "static" : reduceMotion ? "pulse" : "sweep";
  return (
    <span
      className={cn("working-text", mode !== "static" && `working-text--${mode}`, className)}
      data-working-text={mode}
    >
      {children}
    </span>
  );
}
