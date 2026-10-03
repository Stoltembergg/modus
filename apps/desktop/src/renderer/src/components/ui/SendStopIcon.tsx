import { IconArrowUp, IconPlayerStopFilled } from "@tabler/icons-react";
import { m, useReducedMotion } from "motion/react";
import { cn } from "../../lib/cn";

type SendStopIconProps = {
  busy: boolean;
  className?: string | undefined;
};

const SWITCH_S = 0.2;

/**
 * Send (arrow up) / stop (square) glyph for the composer button. Both icons share one
 * box; switching crossfades with a small scale + rotation. Decorative only: the button
 * keeps its own send/stop label. Reduced motion switches instantly.
 */
export function SendStopIcon({ busy, className }: SendStopIconProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const transition = { duration: reduceMotion ? 0 : SWITCH_S, ease: "easeOut" } as const;
  return (
    <span aria-hidden="true" className={cn("relative inline-grid", className)}>
      <m.span
        animate={
          busy ? { opacity: 0, scale: 0.6, rotate: -45 } : { opacity: 1, scale: 1, rotate: 0 }
        }
        className="col-start-1 row-start-1 flex items-center justify-center"
        data-icon="send"
        data-visible={busy ? "false" : "true"}
        initial={false}
        transition={transition}
      >
        <IconArrowUp className="size-full" stroke={2.25} />
      </m.span>
      <m.span
        animate={
          busy ? { opacity: 1, scale: 1, rotate: 0 } : { opacity: 0, scale: 0.6, rotate: 45 }
        }
        className="col-start-1 row-start-1 flex items-center justify-center"
        data-icon="stop"
        data-visible={busy ? "true" : "false"}
        initial={false}
        transition={transition}
      >
        <IconPlayerStopFilled className="size-[80%]" />
      </m.span>
    </span>
  );
}
