/*
 * Send/stop glyph adapted from React Bits PromptBar (SendGlyph)
 * https://github.com/DavidHDev/react-bits, MIT + Commons Clause.
 * One path morphs from the arrow to the stop square with a small pinch and lean
 * mid-way. Reduced motion jumps straight to the end shape.
 */
import { animate, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/cn";

type SendStopIconProps = {
  busy: boolean;
  className?: string | undefined;
};

const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
const MORPH_S = 0.24;
const SQUASH = 0.12;
const TILT = 8;

export function sendStopPath(t: number): string {
  let d = "";
  for (let i = 0; i < ARROW_UP.length; i += 2) {
    const x = (ARROW_UP[i] ?? 0) + ((SQUARE[i] ?? 0) - (ARROW_UP[i] ?? 0)) * t;
    const y = (ARROW_UP[i + 1] ?? 0) + ((SQUARE[i + 1] ?? 0) - (ARROW_UP[i + 1] ?? 0)) * t;
    d += `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return `${d}Z`;
}

export function SendStopIcon({ busy, className }: SendStopIconProps) {
  const reduce = useReducedMotion() ?? false;
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const dir = useRef(busy ? 1 : -1);
  const t = useMotionValue(busy ? 1 : 0);

  useEffect(() => {
    const target = busy ? 1 : 0;
    dir.current = busy ? 1 : -1;
    if (t.get() === target) return undefined;
    const controls = animate(
      t,
      target,
      reduce ? { duration: 0 } : { duration: MORPH_S, ease: EASE_IN_OUT },
    );
    return () => controls.stop();
  }, [busy, reduce, t]);

  useMotionValueEvent(t, "change", (v) => {
    pathRef.current?.setAttribute("d", sendStopPath(v));
    const goo = reduce ? 0 : Math.sin(v * Math.PI);
    const sx = 1 - SQUASH * goo;
    if (svgRef.current) {
      svgRef.current.style.transform = goo
        ? `rotate(${dir.current * TILT * goo}deg) scale(${sx}, ${1 / sx})`
        : "";
    }
  });

  return (
    <span aria-hidden="true" className={cn("relative inline-grid", className)}>
      <svg
        className="block size-full origin-center"
        data-icon={busy ? "stop" : "send"}
        data-visible="true"
        fill="currentColor"
        ref={svgRef}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <path d={sendStopPath(t.get())} ref={pathRef} />
      </svg>
    </span>
  );
}
