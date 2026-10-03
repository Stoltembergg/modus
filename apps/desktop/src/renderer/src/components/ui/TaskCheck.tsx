import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

type TaskCheckProps = {
  checked: boolean;
  "aria-label": string;
  className?: string | undefined;
  /** Box edge in px. */
  size?: number | undefined;
};

/**
 * Read-only task checkbox glyph. Unchecked: muted outline. Checked: accent fill with a
 * check in the accent's contrast colour. Turning checked plays a short pop and draws the
 * mark (stroke-dashoffset); unchecking just switches. It is an image, not an input: if an
 * interactive use appears, use a real `<input type="checkbox">` instead.
 */
export function TaskCheck({
  checked,
  "aria-label": ariaLabel,
  className,
  size = 16,
}: TaskCheckProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const previous = useRef(checked);
  const [pop, setPop] = useState(false);

  useEffect(() => {
    if (checked && !previous.current) setPop(true);
    if (!checked) setPop(false);
    previous.current = checked;
  }, [checked]);

  return (
    <span
      aria-label={ariaLabel}
      className={cn("task-check", className)}
      data-pop={pop && !reduceMotion ? "" : undefined}
      data-state={checked ? "checked" : "unchecked"}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setPop(false);
      }}
      role="img"
      style={{ width: size, height: size }}
    >
      <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 16 16" width={size}>
        <rect className="task-check__box" height="13.5" rx="3.5" width="13.5" x="1.25" y="1.25" />
        {checked ? (
          <path className="task-check__mark" d="M4.6 8.3 7 10.6l4.4-5" pathLength={1} />
        ) : null}
      </svg>
    </span>
  );
}
