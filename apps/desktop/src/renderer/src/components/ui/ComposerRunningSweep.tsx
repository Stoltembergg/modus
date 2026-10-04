import { m } from "motion/react";

/**
 * Composer "running" signal: a thin accent line sweeping along the top edge in a loop
 * (CSS `background-position` keyframes; static under reduced motion). Sits on the border,
 * never over the text, and fades in/out (~250 ms) via the parent's AnimatePresence.
 */
export function ComposerRunningSweep() {
  return (
    <m.span
      animate={{ opacity: 1 }}
      aria-hidden="true"
      className="composer-running-sweep"
      data-composer-running=""
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    />
  );
}
