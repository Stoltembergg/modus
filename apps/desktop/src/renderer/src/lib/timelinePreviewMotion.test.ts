import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layoutSnap, MOTION_EASE, reducedFade, timelinePreviewMotion, tween } from "./motion";

describe("timeline preview motion", () => {
  it("reduced motion is a 120 ms opacity fade: no scale, position snaps", () => {
    const reduced = timelinePreviewMotion(true);
    for (const target of [reduced.initial, reduced.animate, reduced.exit]) {
      expect(Object.keys(target)).toEqual(["opacity"]);
    }
    expect(reduced.transition).toMatchObject({ duration: 0.12, ease: MOTION_EASE.linear });
    expect(reduced.transition).toMatchObject({ ...reducedFade, x: layoutSnap, y: layoutSnap });
  });

  it("full motion keeps the slight scale pop on the fast token", () => {
    const full = timelinePreviewMotion(false);
    expect(full.initial).toEqual({ opacity: 0, scale: 0.985 });
    expect(full.exit).toEqual({ opacity: 0, scale: 0.99 });
    expect(full.transition).toEqual(tween("fast"));
  });

  it("the preview reads its motion from the reduced-motion preference", () => {
    const src = readFileSync(
      new URL("../features/agent/ConversationTimeline.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("timelinePreviewMotion(useReducedMotion())");
    expect(src).not.toMatch(/scale:\s*0\.98/);
  });
});
