import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MotionValue, Transition } from "motion/react";
import { describe, expect, it } from "vitest";
import {
  animatePanelWidth,
  imageViewerMotion,
  layoutSnap,
  MOTION_DURATION,
  MOTION_EASE,
  MOTION_REDUCED_DURATION,
  type MotionPreset,
  panelWidthMotion,
  reducedFade,
  reducedSwapFade,
  swapTransition,
  tween,
} from "./motion";

/**
 * Reduced-motion follow-up to #280: the sites that never checked reduced
 * motion (disclosure chevrons, image viewer, panel widths) and the two
 * fade-out-then-in content swaps.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");

const MOVEMENT = ["x", "y", "scale", "scaleX", "scaleY", "rotate", "width", "height"];

function expectOpacityOnly(preset: MotionPreset) {
  for (const target of [preset.initial, preset.animate, preset.exit]) {
    expect(Object.keys(target).filter((key) => MOVEMENT.includes(key))).toEqual([]);
    expect(Object.keys(target)).toContain("opacity");
  }
  expect(preset.transition).toBe(reducedFade);
  expect(preset.transition.duration).toBeGreaterThan(0);
}

describe("image viewer", () => {
  it("only fades under reduced motion (no zoom, no drop-in), 120ms linear", () => {
    const reduced = imageViewerMotion(true);
    expectOpacityOnly(reduced.backdrop);
    expectOpacityOnly(reduced.stage);
    expectOpacityOnly(reduced.toolbar);
    expect(reduced.stage.transition).toMatchObject({ duration: 0.12, ease: MOTION_EASE.linear });
  });

  it("keeps the full-motion zoom and drop-in unchanged", () => {
    const full = imageViewerMotion(false);
    expect(full.backdrop).toEqual({
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: tween("slow"),
    });
    expect(full.stage).toEqual({
      initial: { opacity: 0, scale: 0.98 },
      animate: { opacity: 1, scale: 1 },
      exit: { opacity: 0, scale: 0.98 },
      transition: tween("slow", "emphasized"),
    });
    expect(full.toolbar).toEqual({
      initial: { opacity: 0, y: -4 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0 },
      transition: tween("base", "standard", { delay: 0.04 }),
    });
  });

  it("ImageViewer takes every enter/exit from imageViewerMotion", () => {
    const viewer = source("components/ui/ImageViewer.tsx");
    expect(viewer).toContain("imageViewerMotion(reducedMotion)");
    expect(viewer).not.toMatch(/\b(?:scale|rotate|y):\s*-?\d/);
  });
});

type Call = { value: string; target: number; transition: Transition & { onComplete?: () => void } };

function fakeValue(name: string, initial: number) {
  let current = initial;
  return {
    name,
    get: () => current,
    set: (next: number) => {
      current = next;
    },
  } as unknown as MotionValue<number> & { name: string };
}

/** Records animations; `finish()` lands them (in order) and fires onComplete. */
function recorder() {
  const calls: Call[] = [];
  const pending: { value: MotionValue<number>; call: Call }[] = [];
  const animator = (
    value: MotionValue<number>,
    target: number,
    transition: Transition & { onComplete?: () => void },
  ) => {
    const call = { value: (value as unknown as { name: string }).name, target, transition };
    calls.push(call);
    pending.push({ value, call });
    return { stop: () => {} };
  };
  const finish = () => {
    while (pending.length > 0) {
      const next = pending.shift();
      if (!next) break;
      next.value.set(next.call.target);
      next.call.transition.onComplete?.();
    }
  };
  return { calls, animator, finish };
}

const TREE = { width: tween("emphasized", "gentle") };
const INSPECTOR = { width: tween("slow", "gentle"), content: tween("instant", "linear") };

describe("panel widths (Files tree, terminal list, Inspector)", () => {
  it("reduced motion snaps the width and fades the content for 120ms", () => {
    const motion = panelWidthMotion(TREE, true);
    expect(motion.width).toBe(layoutSnap);
    expect(motion.content).toBe(reducedFade);
    expect(motion.content?.duration).toBe(MOTION_REDUCED_DURATION);
  });

  it("reduced open: width snaps, then the content fades in (opacity only)", () => {
    const width = fakeValue("width", 0);
    const content = fakeValue("content", 0);
    const { calls, animator, finish } = recorder();
    const settled: boolean[] = [];
    animatePanelWidth(
      width,
      content,
      {
        open: true,
        openWidth: 240,
        motion: panelWidthMotion(TREE, true),
        onSettled: (open) => settled.push(open),
      },
      animator,
    );
    finish();
    expect(calls.map(({ value, target }) => [value, target])).toEqual([
      ["width", 240],
      ["content", 1],
    ]);
    expect(calls[0]?.transition).toMatchObject({ duration: 0 });
    expect(calls[1]?.transition).toMatchObject({ duration: 0.12, ease: MOTION_EASE.linear });
    expect(settled).toEqual([true]);
  });

  it("reduced close: the content fades out first, then the width snaps shut", () => {
    const width = fakeValue("width", 240);
    const content = fakeValue("content", 1);
    const { calls, animator, finish } = recorder();
    const settled: boolean[] = [];
    animatePanelWidth(
      width,
      content,
      {
        open: false,
        openWidth: 240,
        motion: panelWidthMotion(INSPECTOR, true),
        onSettled: (open) => settled.push(open),
      },
      animator,
    );
    expect(calls.map(({ value, target }) => [value, target])).toEqual([["content", 0]]);
    expect(settled).toEqual([]);
    finish();
    expect(calls.map(({ value, target }) => [value, target])).toEqual([
      ["content", 0],
      ["width", 0],
    ]);
    expect(calls[0]?.transition).toMatchObject({ duration: 0.12 });
    expect(calls[1]?.transition).toMatchObject({ duration: 0 });
    expect(settled).toEqual([false]);
    expect(width.get()).toBe(0);
  });

  it("full motion is unchanged: the width tweens and clipped content stays opaque", () => {
    const width = fakeValue("width", 240);
    const content = fakeValue("content", 1);
    const { calls, animator, finish } = recorder();
    animatePanelWidth(
      width,
      content,
      { open: false, openWidth: 240, motion: panelWidthMotion(TREE, false) },
      animator,
    );
    finish();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      value: "width",
      target: 0,
      transition: { duration: MOTION_DURATION.emphasized, ease: MOTION_EASE.gentle },
    });
    expect(content.get()).toBe(1);
  });

  it("full motion Inspector: content hides on close and fades in after the width on open", () => {
    const width = fakeValue("width", 400);
    const content = fakeValue("content", 1);
    const close = recorder();
    animatePanelWidth(
      width,
      content,
      { open: false, openWidth: 400, motion: panelWidthMotion(INSPECTOR, false) },
      close.animator,
    );
    expect(content.get()).toBe(0);
    close.finish();
    const open = recorder();
    animatePanelWidth(
      width,
      content,
      { open: true, openWidth: 400, motion: panelWidthMotion(INSPECTOR, false) },
      open.animator,
    );
    open.finish();
    expect(open.calls.map(({ value, target }) => [value, target])).toEqual([
      ["width", 400],
      ["content", 1],
    ]);
    expect(open.calls[0]?.transition).toMatchObject({ duration: MOTION_DURATION.slow });
    expect(open.calls[1]?.transition).toMatchObject({ duration: MOTION_DURATION.instant });
    // A width change while already open does not re-fade the content.
    const resize = recorder();
    animatePanelWidth(
      width,
      content,
      { open: true, openWidth: 520, motion: panelWidthMotion(INSPECTOR, false) },
      resize.animator,
    );
    resize.finish();
    expect(resize.calls.map(({ value }) => value)).toEqual(["width"]);
  });

  it.each([
    ["features/files/FilesPanel.tsx", "panelWidthMotion({ width: TREE_TRANSITION }"],
    ["features/terminal/TerminalPanel.tsx", "panelWidthMotion({ width: TERMINAL_LIST_TRANSITION }"],
    ["features/inspector/Inspector.tsx", "panelWidthMotion(INSPECTOR_MOTION"],
  ])("%s drives its width through animatePanelWidth", (rel, recipe) => {
    const text = source(rel);
    expect(text).toContain(recipe);
    expect(text).toContain("animatePanelWidth(");
    expect(text).toContain("useReducedMotion()");
    // No raw width tween left that would ignore reduced motion.
    expect(text).not.toMatch(/(?<![\w.])animate\(/);
  });
});

describe("content swaps (conversation/home, ContentTransition)", () => {
  it("a reduced fade-out-then-in swap takes 120ms in total", () => {
    const exit = swapTransition(tween("base"), true);
    const enter = swapTransition(tween("base"), true);
    expect(exit).toBe(reducedSwapFade);
    expect((exit.duration ?? 0) + (enter.duration ?? 0)).toBeCloseTo(MOTION_REDUCED_DURATION, 10);
    expect(Math.round(((exit.duration ?? 0) + (enter.duration ?? 0)) * 1000)).toBe(120);
    expect(exit.duration).toBeGreaterThan(0);
    expect(exit.ease).toEqual(MOTION_EASE.linear);
  });

  it("full motion keeps each swap's own transition", () => {
    const own = tween("fast");
    expect(swapTransition(own, false)).toBe(own);
    expect(swapTransition(own, null)).toBe(own);
  });

  it("both swaps use the halved reduced fade", () => {
    expect(source("components/ui/ContentTransition.tsx")).toContain(
      "swapTransition(TRANSITION, reduceMotion)",
    );
    const app = source("app/App.tsx");
    expect(app).toContain("? reducedSwapFade");
    expect(app).toContain('swapTransition(tween("fast"), reduceMotion)');
  });
});

const CHEVRON_SITES = [
  "features/agent/terminal/TerminalToolCard.tsx",
  "features/files/FilesPanel.tsx",
  "features/composer/ComposerRail.tsx",
  "features/agent/SearchToolCard.tsx",
  "features/settings/CustomProviderForm.tsx",
  "features/agent/diff/DiffToolCard.tsx",
  "features/agent/ToolCard.tsx",
  "features/agent/TodosCard.tsx",
  "features/settings/form-controls.tsx",
  "components/question/QuestionCard.tsx",
  "features/settings/settings-provider-ui.tsx",
  "features/agent/ActivityGroup.tsx",
  "features/agent/ToolGroup.tsx",
  "components/Sidebar.tsx",
];

/** The `@media (prefers-reduced-motion: reduce)` block inside the chevron's layer. */
function chevronCss() {
  const css = source("styles/app.css");
  const start = css.indexOf("@layer components {\n  .disclosure-chevron {");
  expect(start).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("@keyframes disclosure-chevron-fade-closed", start));
  const reducedAt = block.indexOf("@media (prefers-reduced-motion: reduce)");
  return { css, full: block.slice(0, reducedAt), reduced: block.slice(reducedAt) };
}

describe("disclosure chevrons", () => {
  it.each(CHEVRON_SITES)("%s uses .disclosure-chevron with data-open", (rel) => {
    const text = source(rel);
    expect(text).toContain("disclosure-chevron");
    expect(text).toMatch(/data-open=\{\w+ \? "" : undefined\}/);
    expect(text).not.toMatch(/&&\s*"rotate-90"/);
    expect(text).not.toMatch(/animate=\{\{\s*rotate:/);
  });

  it("full motion rotates; reduced motion snaps the angle and fades opacity for 120ms", () => {
    const { css, full, reduced } = chevronCss();
    expect(full).toMatch(/transition-property:\s*rotate;/);
    expect(full).toMatch(/\[data-open\]\s*\{\s*rotate:\s*90deg;/);
    // Reduced: nothing rotates over time, opacity animates, duration is nonzero.
    expect(reduced).not.toMatch(/transition-property:[^;]*rotate/);
    expect(reduced).toMatch(/transition-property:\s*opacity;/);
    expect(reduced).toMatch(
      /animation:\s*disclosure-chevron-fade-closed var\(--motion-duration-reduced\)\s*var\(--motion-ease-linear\)/,
    );
    expect(reduced).toMatch(/\[data-open\]\s*\{\s*animation-name:\s*disclosure-chevron-fade-open;/);
    expect(css).toMatch(/--motion-duration-reduced:\s*120ms;/);
    for (const name of ["open", "closed"]) {
      const keyframes = css.match(
        new RegExp(`@keyframes disclosure-chevron-fade-${name} \\{([^}]*\\})\\s*\\}`),
      );
      expect(keyframes?.[1]).toMatch(/^\s*from\s*\{\s*opacity:\s*0\.35;\s*\}$/);
    }
  });
});
