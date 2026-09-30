/**
 * Spring Check — adapted from React Bits micro interaction
 * https://reactbits.dev/micro/spring-check (DavidHDev/react-bits).
 * Motion via motion/react; colors via CSS vars / props.
 */
import { type AnimationPlaybackControls, animate, useReducedMotion } from "motion/react";
import { type CSSProperties, useEffect, useRef } from "react";
import { cn } from "../../lib/cn";

export type SpringCheckProps = {
  checked: boolean;
  /** When true, the control is display-only (agents mark done; user observes). */
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  color?: string;
  fillColor?: string;
  checkColor?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
};

const EASE_SPRING: [number, number, number, number] = [0.34, 1.56, 0.64, 1];
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

export function SpringCheck({
  checked,
  disabled = false,
  onChange,
  color = "var(--color-fg-muted, currentColor)",
  fillColor = "var(--color-accent, #5b8def)",
  checkColor = "var(--color-accent-fg, #fff)",
  size = 16,
  className,
  style,
  "aria-label": ariaLabel = "Done",
}: SpringCheckProps) {
  const reduce = useReducedMotion();
  const boxRef = useRef<SVGRectElement>(null);
  const checkRef = useRef<SVGPathElement>(null);
  const scaleRef = useRef<SVGGElement>(null);
  const anims = useRef<AnimationPlaybackControls[]>([]);

  useEffect(() => {
    for (const a of anims.current) a.stop();
    anims.current = [];
    const box = boxRef.current;
    const check = checkRef.current;
    const scale = scaleRef.current;
    if (!box || !check || !scale) return;

    if (reduce) {
      box.setAttribute("fill", checked ? fillColor : "transparent");
      box.setAttribute("stroke", checked ? fillColor : color);
      check.style.opacity = checked ? "1" : "0";
      check.style.strokeDashoffset = checked ? "0" : "12";
      scale.style.transform = "scale(1)";
      return;
    }

    if (checked) {
      anims.current.push(
        animate(scale, { scale: [1, 0.86, 1.08, 1] }, { duration: 0.42, ease: EASE_SPRING }),
      );
      anims.current.push(
        animate(box, { fill: fillColor, stroke: fillColor }, { duration: 0.22, ease: EASE_OUT }),
      );
      check.style.opacity = "1";
      check.style.strokeDasharray = "12";
      check.style.strokeDashoffset = "12";
      anims.current.push(
        animate(check, { strokeDashoffset: 0 }, { duration: 0.28, delay: 0.08, ease: EASE_OUT }),
      );
    } else {
      anims.current.push(
        animate(check, { strokeDashoffset: 12, opacity: 0 }, { duration: 0.15, ease: EASE_OUT }),
      );
      anims.current.push(
        animate(box, { fill: "transparent", stroke: color }, { duration: 0.2, ease: EASE_OUT }),
      );
      anims.current.push(animate(scale, { scale: 1 }, { duration: 0.2, ease: EASE_OUT }));
    }
    return () => {
      for (const a of anims.current) a.stop();
    };
  }, [checked, color, fillColor, reduce]);

  const interactive = Boolean(onChange) && !disabled;

  return (
    <label
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-sm",
        interactive && "cursor-pointer hover:opacity-90",
        disabled && "opacity-50",
        className,
      )}
      data-checked={checked || undefined}
      data-testid="spring-check"
      style={style}
    >
      <input
        aria-label={ariaLabel}
        checked={checked}
        className="sr-only"
        disabled={disabled || !interactive}
        onChange={(event) => {
          if (interactive) onChange?.(event.target.checked);
        }}
        type="checkbox"
      />
      <svg aria-hidden focusable="false" height={size} viewBox="0 0 16 16" width={size}>
        <title>{ariaLabel}</title>
        <g ref={scaleRef} style={{ transformBox: "fill-box", transformOrigin: "center" }}>
          <rect
            fill={checked && reduce ? fillColor : "transparent"}
            height="14"
            ref={boxRef}
            rx="3.5"
            stroke={checked && reduce ? fillColor : color}
            strokeWidth="1.5"
            width="14"
            x="1"
            y="1"
          />
          <path
            d="M4.2 8.2 L7 10.8 L11.8 5.4"
            fill="none"
            ref={checkRef}
            stroke={checkColor}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            style={{ opacity: checked && reduce ? 1 : 0 }}
          />
        </g>
      </svg>
    </label>
  );
}
