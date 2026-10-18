import type { TargetAndTransition, Transition } from "motion/react";

/**
 * Modus motion tokens: the one scale every animation in the renderer uses.
 *
 * TSX reads the values below (seconds, cubic-bézier arrays, spring presets).
 * CSS reads the same scale as custom properties in styles/app.css
 * (`--motion-duration-*`, `--motion-ease-*`); lib/motion.test.ts fails when the
 * two drift apart.
 *
 * Reduced motion never means "no animation". With the OS setting on, anything
 * that moves (translate, scale, rotate, layout) stops moving and the change is
 * carried by a short opacity fade instead (`reducedFade`). `<MotionConfig
 * reducedMotion="user">` at the app root covers positional values for every
 * `m.*` element; the helpers here make each site's intent explicit and also
 * cover scale/rotate, which MotionConfig leaves alone.
 */

/** Durations in seconds (motion/react). CSS: `--motion-duration-<name>` in ms. */
export const MOTION_DURATION = {
  /** Micro feedback: hover tints, tiny cross-fades. */
  instant: 0.08,
  /** Small controls, menus, tooltips; also the reduced-motion fade. */
  fast: 0.12,
  /** Default UI transition: rows, cards, content swaps. */
  base: 0.16,
  /** Panels, sheets, dialogs, rail width. */
  slow: 0.2,
  /** Larger reveals and deliberate, noticeable moves. */
  emphasized: 0.28,
} as const;

export type MotionDurationName = keyof typeof MOTION_DURATION;

/** Length of the opacity fade that replaces movement under reduced motion. */
export const MOTION_REDUCED_DURATION = MOTION_DURATION.fast;

type CubicBezier = readonly [number, number, number, number];

/** Easing curves. CSS: `--motion-ease-<kebab-name>` as `cubic-bezier(...)`. */
export const MOTION_EASE = {
  /** Decelerating out-quint: enters and state changes (most of the app). */
  standard: [0.22, 1, 0.36, 1],
  /** Stronger out-expo: large surfaces arriving (image viewer, sheets). */
  emphasized: [0.16, 1, 0.3, 1],
  /** Accelerating: things leaving the screen. */
  exit: [0.4, 0, 1, 1],
  /** CSS `ease`: panel resizes and expand/collapse, where out-quint feels abrupt. */
  gentle: [0.25, 0.1, 0.25, 1],
  /** Symmetric: loops and back-and-forth moves. */
  inOut: [0.42, 0, 0.58, 1],
  /** Constant speed: the reduced-motion fade, progress, steady loops. */
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, CubicBezier>;

export type MotionEaseName = keyof typeof MOTION_EASE;

/** Spring presets (transform only; reduced motion swaps them for `reducedFade`). */
export const MOTION_SPRING = {
  /** Small indicators that slide between options (selection rings). */
  snappy: { type: "spring", stiffness: 520, damping: 38, mass: 0.6 },
  /** Dialog open/close. */
  dialog: { type: "spring", stiffness: 420, damping: 34, mass: 0.8 },
  /** Playful preview feedback with a little overshoot. */
  bouncy: { type: "spring", stiffness: 480, damping: 26, mass: 0.7 },
  /** Shared-layout morphs (MorphingDialog). */
  morph: { type: "spring", stiffness: 280, damping: 28, mass: 0.8 },
} as const satisfies Record<string, Transition>;

export type MotionSpringName = keyof typeof MOTION_SPRING;

/** `{ duration, ease }` from token names. */
export function tween(
  duration: MotionDurationName = "base",
  ease: MotionEaseName = "standard",
  extra?: Omit<Transition, "duration" | "ease">,
): Transition {
  return { duration: MOTION_DURATION[duration], ease: MOTION_EASE[ease], ...extra };
}

/**
 * Instant size/position change for a container whose content fades with
 * `reducedFade` (NavRail width, shared-layout morphs under reduced motion).
 * Only this file may build a zero-duration transition; motionScan.test.ts
 * enforces that.
 */
export const layoutSnap: Transition = Object.freeze({ duration: 0 });

/**
 * The reduced-motion replacement for any movement: a short, linear opacity
 * fade. Layout (projection) animations snap, since they are pure movement.
 */
export const reducedFade: Transition = Object.freeze({
  duration: MOTION_REDUCED_DURATION,
  ease: MOTION_EASE.linear,
  layout: layoutSnap,
});

/** `transition` for a site: its normal transition, or `reducedFade` when reduced. */
export function motionTransition(
  transition: Transition,
  reduced: boolean | null | undefined,
): Transition {
  return reduced ? reducedFade : transition;
}

/** A movement offset (px, scale delta...) that collapses to its resting value when reduced. */
export function motionOffset<T extends number>(
  value: T,
  reduced: boolean | null | undefined,
  rest = 0,
): number {
  return reduced ? rest : value;
}

const MOVEMENT_KEYS = new Set([
  "x",
  "y",
  "z",
  "translateX",
  "translateY",
  "translateZ",
  "scale",
  "scaleX",
  "scaleY",
  "rotate",
  "rotateX",
  "rotateY",
  "rotateZ",
  "skew",
  "skewX",
  "skewY",
  "height",
  "width",
  "top",
  "left",
  "right",
  "bottom",
  "filter",
]);

type MotionTarget = TargetAndTransition & Record<string, unknown>;

/** Drops every moving property from a motion target when reduced, keeping opacity/colour. */
export function reducedTarget<T extends MotionTarget>(
  target: T,
  reduced: boolean | null | undefined,
): T {
  if (!reduced) return target;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(target)) {
    if (key === "transition" || MOVEMENT_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out as T;
}

export type MotionPresetName = "fade" | "fadeUp" | "fadeDown" | "pop" | "slideInLeft";

export type MotionPreset = {
  initial: MotionTarget;
  animate: MotionTarget;
  exit: MotionTarget;
  transition: Transition;
};

const PRESETS: Record<MotionPresetName, MotionPreset> = {
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: tween("base"),
  },
  fadeUp: {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -3 },
    transition: tween("base"),
  },
  fadeDown: {
    initial: { opacity: 0, y: -4 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4 },
    transition: tween("base"),
  },
  pop: {
    initial: { opacity: 0, scale: 0.96 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.96 },
    transition: tween("fast"),
  },
  slideInLeft: {
    initial: { opacity: 0, x: -24 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -24 },
    transition: tween("base"),
  },
};

/**
 * Enter/exit recipe by name. Reduced motion keeps only the opacity part of each
 * target and fades with `reducedFade` (never a zero duration).
 */
export function motionPreset(
  name: MotionPresetName,
  reduced: boolean | null | undefined,
): MotionPreset {
  const preset = PRESETS[name];
  if (!reduced) return preset;
  return {
    initial: reducedTarget(preset.initial, true),
    animate: reducedTarget(preset.animate, true),
    exit: reducedTarget(preset.exit, true),
    transition: reducedFade,
  };
}

/* NavRail (moved from components/ui/NavRail.tsx). */

export type NavRailMotion = {
  /** Transition for the rail width (snaps when motion is reduced). */
  width: Transition;
  /** Transition for content that appears with the expanded rail. */
  content: Transition;
  /** Horizontal offset content enters from (0 when motion is reduced). */
  offsetX: number;
  /** Offset the compact overlay sheet slides in from (0 when motion is reduced). */
  sheetOffsetX: number;
  reduced: boolean;
};

/** Motion recipe for the rail; reduced motion snaps the width and fades content (120ms). */
export function navRailMotion(reduced: boolean): NavRailMotion {
  return reduced
    ? { width: layoutSnap, content: reducedFade, offsetX: 0, sheetOffsetX: 0, reduced: true }
    : {
        width: tween("slow"),
        content: tween("base"),
        offsetX: -4,
        sheetOffsetX: -24,
        reduced: false,
      };
}

/* CSS mirror (consumed by lib/motion.test.ts). */

/** CSS custom-property name for a token, e.g. `inOut` → `--motion-ease-in-out`. */
export function motionCssVar(kind: "duration" | "ease", name: string): string {
  return `--motion-${kind}-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** The CSS value a token must have in styles/app.css. */
export function motionCssValue(kind: "duration" | "ease", name: string): string {
  if (kind === "duration") {
    const seconds = MOTION_DURATION[name as MotionDurationName];
    return `${Math.round(seconds * 1000)}ms`;
  }
  const curve = MOTION_EASE[name as MotionEaseName];
  return name === "linear" ? "linear" : `cubic-bezier(${curve.join(", ")})`;
}
