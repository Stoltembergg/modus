import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Activity PR 2: keyboard focus uses the accent ring (never the browser outline),
 * and the first-page load shows a skeleton instead of a blank panel.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("./app.css").replace(/\s*\n\s*(?=[:.])/g, " ");

function block(selector: string, from = 0): string {
  const at = css.indexOf(`${selector} {`, from);
  expect(at, `${selector} exists`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

describe("Activity focus ring", () => {
  it("every focusable Activity control gets the 2px accent ring on focus-visible", () => {
    const rule = block(
      '.activity-panel :is(button, a[href], [role="button"], [tabindex]:not([tabindex="-1"])):focus-visible',
    );
    expect(rule).toMatch(/outline:\s*2px solid var\(--color-accent\)/);
    expect(css).not.toMatch(/\.activity-panel[^{]*:focus\s*\{/);
  });

  it("diff actions become visible when they take keyboard focus", () => {
    const src = read("../features/agent/diff/DiffToolCard.tsx");
    const hidden = src.match(/opacity-0[^"]*group-hover\/diff:opacity-100[^"]*/g) ?? [];
    expect(hidden.length).toBeGreaterThan(0);
    for (const cls of hidden) expect(cls).toContain("group-focus-within/diff:opacity-100");
  });
});

describe("Activity loading skeleton", () => {
  it("renders while the first page loads, text-free", () => {
    const src = read("../features/agent/ActivityTimeline.tsx");
    expect(src).toContain('className="activity-skeleton"');
    expect(src).toContain("aria-busy={showSkeleton || undefined}");
  });

  it("uses motion tokens and is a 120ms fade without shimmer under reduced motion", () => {
    expect(block(".activity-skeleton")).toContain("var(--motion-duration-base)");
    const reduce = css.slice(css.indexOf(".activity-skeleton__bar {"));
    const media = reduce.slice(reduce.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(media).toMatch(
      /\.activity-skeleton \{\s*animation: activity-skeleton-in var\(--motion-duration-reduced\)/,
    );
    expect(media).toMatch(
      /\.activity-skeleton__bar \{\s*animation: activity-skeleton-in var\(--motion-duration-reduced\)[^;]*;\s*background-image: none;/,
    );
  });
});
