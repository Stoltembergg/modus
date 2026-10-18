import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  layoutSnap,
  MOTION_DURATION,
  MOTION_EASE,
  MOTION_REDUCED_DURATION,
  MOTION_SPRING,
  type MotionPresetName,
  motionCssValue,
  motionCssVar,
  motionOffset,
  motionPreset,
  motionTransition,
  navRailMotion,
  reducedFade,
  reducedTarget,
  tween,
} from "./motion";

const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

/** Value of a custom property declared in app.css (first declaration wins). */
function cssToken(name: string): string | undefined {
  const match = css.match(new RegExp(`(?<![\\w-])${name}:\\s*([^;]+);`));
  return match?.[1]?.trim();
}

describe("motion tokens", () => {
  it("is a small, strictly increasing duration scale", () => {
    const values = Object.values(MOTION_DURATION);
    expect(values.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1] as number);
    }
    for (const value of values) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(0.5);
    }
  });

  it("has easing curves as valid cubic-béziers", () => {
    for (const curve of Object.values(MOTION_EASE)) {
      expect(curve).toHaveLength(4);
      expect(curve[0]).toBeGreaterThanOrEqual(0);
      expect(curve[0]).toBeLessThanOrEqual(1);
      expect(curve[2]).toBeGreaterThanOrEqual(0);
      expect(curve[2]).toBeLessThanOrEqual(1);
    }
  });

  it("springs are springs", () => {
    for (const spring of Object.values(MOTION_SPRING)) {
      expect(spring.type).toBe("spring");
      expect(spring.stiffness).toBeGreaterThan(0);
      expect(spring.damping).toBeGreaterThan(0);
    }
  });

  it("tween builds transitions from token names", () => {
    expect(tween()).toEqual({ duration: MOTION_DURATION.base, ease: MOTION_EASE.standard });
    expect(tween("slow", "exit", { delay: 0.04 })).toEqual({
      duration: 0.2,
      ease: MOTION_EASE.exit,
      delay: 0.04,
    });
  });
});

describe("CSS mirror (styles/app.css)", () => {
  it("declares every duration token with the same value", () => {
    for (const name of Object.keys(MOTION_DURATION)) {
      expect(cssToken(motionCssVar("duration", name)), name).toBe(motionCssValue("duration", name));
    }
    expect(cssToken("--motion-duration-reduced")).toBe(
      `${Math.round(MOTION_REDUCED_DURATION * 1000)}ms`,
    );
  });

  it("declares every easing token with the same curve", () => {
    for (const name of Object.keys(MOTION_EASE)) {
      expect(cssToken(motionCssVar("ease", name)), name).toBe(motionCssValue("ease", name));
    }
    expect(motionCssVar("ease", "inOut")).toBe("--motion-ease-in-out");
  });

  it("keeps the Tailwind ease utilities on the same curves", () => {
    for (const name of ["standard", "emphasized", "exit"] as const) {
      expect(cssToken(`--ease-${name}`), name).toBe(motionCssValue("ease", name));
    }
    expect(cssToken("--ease-out-quint")).toBe(motionCssValue("ease", "standard"));
  });

  it("keeps the older names as aliases of the scale", () => {
    expect(cssToken("--motion-fast")).toBe("var(--motion-duration-fast)");
    expect(cssToken("--motion-ui")).toBe("var(--motion-duration-base)");
    expect(cssToken("--motion-overlay")).toBe("var(--motion-duration-slow)");
    expect(cssToken("--ease-ui")).toBe("var(--motion-ease-standard)");
  });
});

describe("reduced motion", () => {
  it("reducedFade is a short linear fade, never zero", () => {
    expect(reducedFade.duration).toBe(MOTION_REDUCED_DURATION);
    expect(reducedFade.duration).toBeGreaterThan(0);
    expect(reducedFade.duration).toBeLessThanOrEqual(0.15);
    expect(reducedFade.ease).toEqual(MOTION_EASE.linear);
    // Layout projection is pure movement: it snaps.
    expect((reducedFade as { layout?: unknown }).layout).toBe(layoutSnap);
  });

  it("motionTransition swaps any transition for the fade", () => {
    const spring = MOTION_SPRING.dialog;
    expect(motionTransition(spring, false)).toBe(spring);
    expect(motionTransition(spring, null)).toBe(spring);
    expect(motionTransition(spring, true)).toBe(reducedFade);
  });

  it("motionOffset collapses movement to its resting value", () => {
    expect(motionOffset(6, false)).toBe(6);
    expect(motionOffset(6, true)).toBe(0);
    expect(motionOffset(0.6, true, 1)).toBe(1);
  });

  it("reducedTarget keeps opacity and drops movement", () => {
    expect(reducedTarget({ opacity: 0, y: 4, scale: 0.96, rotate: 3 }, true)).toEqual({
      opacity: 0,
    });
    const target = { opacity: 0, y: 4 };
    expect(reducedTarget(target, false)).toBe(target);
  });

  it.each<MotionPresetName>([
    "fade",
    "fadeUp",
    "fadeDown",
    "pop",
    "slideInLeft",
  ])("preset %s is opacity-only with a non-zero fade when reduced", (name) => {
    const full = motionPreset(name, false);
    expect(full.transition.duration).toBeGreaterThan(0);
    const reduced = motionPreset(name, true);
    for (const target of [reduced.initial, reduced.animate, reduced.exit]) {
      expect(Object.keys(target)).toEqual(["opacity"]);
    }
    expect(reduced.initial.opacity).not.toBe(reduced.animate.opacity);
    expect(reduced.transition).toBe(reducedFade);
    expect(reduced.transition.duration).toBeGreaterThan(0);
  });

  it("NavRail: width snaps, content fades 120ms, nothing slides", () => {
    const full = navRailMotion(false);
    expect(full.width).toEqual(tween("slow"));
    expect(full.content).toEqual(tween("base"));
    expect(full.offsetX).toBe(-4);
    expect(full.sheetOffsetX).toBe(-24);
    const reduced = navRailMotion(true);
    expect(reduced.width).toBe(layoutSnap);
    expect(reduced.content).toBe(reducedFade);
    expect(reduced.content.duration).toBe(0.12);
    expect(reduced.offsetX).toBe(0);
    expect(reduced.sheetOffsetX).toBe(0);
  });
});
