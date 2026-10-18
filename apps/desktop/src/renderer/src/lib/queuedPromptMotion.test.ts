import { describe, expect, it } from "vitest";
import {
  layoutSnap,
  MOTION_EASE,
  type MotionPreset,
  queuedPromptMotion,
  reducedFade,
  tween,
} from "./motion";

/** Visible prompt queue above the composer (pattern: reducedMotionSites.test.ts). */
const MOVEMENT = ["x", "y", "scale", "scaleX", "scaleY", "rotate", "width", "height"];

function expectOpacityOnly(preset: MotionPreset) {
  for (const target of [preset.initial, preset.animate, preset.exit]) {
    expect(Object.keys(target).filter((key) => MOVEMENT.includes(key))).toEqual([]);
    expect(Object.keys(target)).toContain("opacity");
  }
  expect(preset.transition).toBe(reducedFade);
  expect(preset.transition.duration).toBeGreaterThan(0);
}

describe("queued prompt strip motion", () => {
  it("reduced motion only fades (120ms linear) and layout snaps, never zero-length fades", () => {
    const reduced = queuedPromptMotion(true);
    expectOpacityOnly(reduced.strip);
    expectOpacityOnly(reduced.item);
    expect(reduced.item.transition).toMatchObject({ duration: 0.12, ease: MOTION_EASE.linear });
    expect((reduced.item.transition as { layout?: unknown }).layout).toBe(layoutSnap);
  });

  it("full motion rises in, reflows with layout motion, all from tokens", () => {
    const full = queuedPromptMotion(false);
    expect(full.strip).toEqual({
      initial: { opacity: 0, y: 6 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: 6 },
      transition: { ...tween("base"), layout: tween("base") },
    });
    expect(full.item).toEqual({
      initial: { opacity: 0, y: 4 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: -4 },
      transition: { ...tween("base"), layout: tween("base") },
    });
  });
});
