// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageViewerProvider } from "../../components/ui/ImageViewer";
import {
  composerImageChipMotion,
  MOTION_EASE,
  type MotionPreset,
  reducedFade,
  tween,
} from "../../lib/motion";
import { Composer } from "./Composer";

/**
 * Composer image chips: reduced motion only fades (follows
 * lib/reducedMotionSites.test.ts), borderless glass chips, accent focus, and
 * every file of a multi-select lands.
 */
const ROOT = `${resolve(process.cwd(), "src/renderer/src")}/`;
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

afterEach(cleanup);

function renderComposer() {
  return render(
    <ImageViewerProvider>
      <Composer
        canSubmit
        contextItems={[]}
        cwd={undefined}
        model=""
        models={[]}
        onContextChange={vi.fn()}
        onSubmit={vi.fn()}
        workspaceId={undefined}
      />
    </ImageViewerProvider>,
  );
}

function png(name: string): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
}

/** A file input whose FileList empties when `value` is cleared, like Chromium's. */
function pickFiles(input: HTMLInputElement, files: File[]): void {
  const live = [...files];
  Object.defineProperty(input, "files", { configurable: true, get: () => live });
  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => (live.length ? "C:\\fakepath\\x.png" : ""),
    set: (next: string) => {
      if (next === "") live.length = 0;
    },
  });
  fireEvent.change(input);
}

async function attach(container: HTMLElement, names: string[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]');
  if (!input) throw new Error("no file input");
  await act(async () => {
    pickFiles(input, names.map(png));
  });
  await waitFor(() =>
    expect(container.querySelectorAll("[data-composer-image]")).toHaveLength(names.length),
  );
}

describe("composer image chip motion", () => {
  it("only fades under reduced motion (no scale), 120ms linear, layout snaps", () => {
    const reduced = composerImageChipMotion(true);
    expectOpacityOnly(reduced);
    expect(reduced.transition).toMatchObject({ duration: 0.12, ease: MOTION_EASE.linear });
    expect((reduced.transition as { layout?: unknown }).layout).toMatchObject({ duration: 0 });
  });

  it("keeps the full-motion pop unchanged", () => {
    expect(composerImageChipMotion(false)).toEqual({
      initial: { opacity: 0, scale: 0.92 },
      animate: { opacity: 1, scale: 1 },
      exit: { opacity: 0, scale: 0.92 },
      transition: tween("base"),
    });
  });

  it("the Composer reads the chip motion from the helper, with no inline scale", () => {
    const composer = source("features/composer/Composer.tsx");
    expect(composer).toContain("composerImageChipMotion(reducedMotion)");
    expect(composer).toContain("useReducedMotion()");
    expect(composer).not.toMatch(/scale:\s*0\.92/);
  });
});

describe("composer image chips", () => {
  it("attaches every file of a multi-select (the input is cleared right after)", async () => {
    const { container } = renderComposer();
    await attach(container, ["a.png", "b.png", "c.png"]);
    expect(container.querySelectorAll('button[aria-label^="Remove"]')).toHaveLength(3);
  });

  it("chips are borderless, use the shared radius and the accent focus ring", async () => {
    const { container } = renderComposer();
    await attach(container, ["a.png"]);
    const chip = container.querySelector<HTMLElement>("[data-composer-image]");
    const thumb = chip?.querySelector("img");
    const remove = chip?.querySelector<HTMLElement>('button[aria-label^="Remove"]');
    for (const el of [chip, thumb, remove]) {
      expect(el?.className ?? "").not.toMatch(/(^|\s)(border|border-[a-z-]+|divide-[a-z-]+)(\s|$)/);
    }
    expect(chip?.className).toContain("rounded-xl");
    expect(thumb?.className).toContain("rounded-xl");
    expect(chip?.className).toContain("ring-focus-ring");
    expect(remove?.className).toContain("focus-visible:ring-focus-ring");
  });

  it("reveals the remove button on keyboard focus, not only on hover", async () => {
    const { container } = renderComposer();
    await attach(container, ["a.png"]);
    const remove = container.querySelector<HTMLElement>('button[aria-label^="Remove"]');
    expect(remove?.className).toContain("opacity-0");
    expect(remove?.className).toContain("group-hover/image:opacity-100");
    expect(remove?.className).toContain("group-focus-within/image:opacity-100");
    expect(remove?.className).toContain("focus-visible:opacity-100");
  });

  it("removing a chip leaves the others", async () => {
    const { container } = renderComposer();
    await attach(container, ["a.png", "b.png"]);
    const first = container.querySelector<HTMLElement>('button[aria-label="Remove a.png"]');
    await act(async () => {
      first?.click();
    });
    await waitFor(() =>
      expect(container.querySelectorAll('button[aria-label^="Remove"]')).toHaveLength(1),
    );
    expect(container.querySelector('button[aria-label="Remove b.png"]')).not.toBeNull();
  });

  it("glass styles come from tokens (no hard-coded colours)", () => {
    const css = source("styles/app.css");
    const block = css.slice(css.indexOf(".composer-image-thumb {"));
    expect(block).toContain("var(--color-chip)");
    expect(block).toContain("var(--glass-filter)");
    expect(block).toContain("var(--color-accent)");
    expect(block.slice(0, block.indexOf(".composer-image-remove {") + 400)).not.toMatch(
      /#[0-9a-f]{3,8}\b|rgba?\(/i,
    );
  });
});
