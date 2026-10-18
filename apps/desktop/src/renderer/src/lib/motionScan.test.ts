import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Reduced motion means a short fade, never "no animation" (lib/motion.ts).
 * This scan fails when a renderer file switches animation off under reduced
 * motion again. If a site truly needs it, add it to ALLOWLIST with the reason.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** `relative/path` → why it may disable motion under reduced motion. */
const ALLOWLIST: Record<string, string> = {
  // The only place a zero-duration transition may be built: `layoutSnap`
  // (container size snaps while its content fades with `reducedFade`).
  "lib/motion.ts": "defines layoutSnap / reducedFade",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = walk(ROOT)
  .map((path) => ({ path, rel: relative(ROOT, path).split("\\").join("/") }))
  .filter(({ rel }) => /\.(tsx?|css)$/.test(rel) && !/\.test\.tsx?$/.test(rel))
  .filter(({ rel }) => !(rel in ALLOWLIST));

/** Bodies of every `@media (prefers-reduced-motion: reduce)` block in `source`. */
function reducedMotionBlocks(source: string): string[] {
  const blocks: string[] = [];
  const opener = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push(source.slice(start, i - 1));
  }
  return blocks;
}

const CSS_OFF = [
  /\banimation(?:-name)?\s*:\s*none\b/,
  /\btransition(?:-property)?\s*:\s*none\b/,
  /\b(?:animation|transition)-duration\s*:\s*0m?s?\s*[;!}]/,
];

const TSX_OFF: { pattern: RegExp; why: string }[] = [
  { pattern: /duration:\s*0(?![.\d])/, why: "zero-duration transition (use reducedFade)" },
  {
    pattern: /duration:\s*!?\w*[Rr]educ\w*\s*\?\s*0\b/,
    why: "duration 0 under reduced motion (use motionTransition)",
  },
  {
    pattern: /initial=\{\s*!?\w*[Rr]educ\w*\s*\?\s*false/,
    why: "skips the entrance under reduced motion (fade it: motionOffset/motionPreset)",
  },
  {
    pattern: /motion-reduce:(?:[\w-]+:)*(?:transition|animate)-none\b/,
    why: "Tailwind motion-reduce:*-none (use motion-reduce:transition-reduced-fade / animate-pulse)",
  },
  {
    pattern: /motion-safe:(?:[\w-]+:)*(?:transition|animate)\b/,
    why: "Tailwind motion-safe: drops the animation under reduced motion (give it a reduced fade instead)",
  },
];

/** Movement that keeps going under reduced motion because nothing guards it. */
const TSX_UNGUARDED: { pattern: RegExp; why: string }[] = [
  {
    pattern: /animate=\{\{\s*rotate:/,
    why: "Motion rotate with no reduced-motion guard (chevrons: .disclosure-chevron + data-open)",
  },
  {
    pattern: /&&\s*"[^"]*\brotate-\d+\b/,
    why: "toggled Tailwind rotation keeps turning under reduced motion (use .disclosure-chevron + data-open)",
  },
];

describe("reduced motion is a fade, never off", () => {
  it("scans a meaningful set of files", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some(({ rel }) => rel === "styles/app.css")).toBe(true);
  });

  it("no CSS rule switches animation or transition off under prefers-reduced-motion", () => {
    const offenders: string[] = [];
    for (const { path, rel } of files) {
      const source = readFileSync(path, "utf8");
      if (!source.includes("prefers-reduced-motion")) continue;
      for (const block of reducedMotionBlocks(source)) {
        for (const rule of CSS_OFF) {
          const hit = block.match(rule);
          if (hit) offenders.push(`${rel}: ${hit[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no TSX site drops motion to zero under reduced motion", () => {
    const offenders: string[] = [];
    for (const { path, rel } of files) {
      if (!/\.tsx?$/.test(rel)) continue;
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const { pattern, why } of TSX_OFF) {
          if (pattern.test(line)) offenders.push(`${rel}:${index + 1}: ${why}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no TSX site rotates on toggle without a reduced-motion guard", () => {
    const offenders: string[] = [];
    for (const { path, rel } of files) {
      if (!/\.tsx?$/.test(rel)) continue;
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const { pattern, why } of TSX_UNGUARDED) {
          if (pattern.test(line)) offenders.push(`${rel}:${index + 1}: ${why}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner catches what it should", () => {
    const css = `@media (prefers-reduced-motion: reduce) { .a { animation: none; } .b { transition: none; } }`;
    const [block] = reducedMotionBlocks(css);
    expect(CSS_OFF.filter((rule) => rule.test(block ?? ""))).toHaveLength(2);
    expect(reducedMotionBlocks(".a { animation: none; }")).toEqual([]);
    const samples = [
      "transition={{ duration: reduceMotion ? 0 : 0.2 }}",
      "initial={reduce ? false : { opacity: 0 }}",
      // Built by concatenation so Tailwind's source scan does not emit these classes.
      `className="animate-spin motion-reduce:${"animate-none"}"`,
      `className="motion-safe:${"animate-pulse"}"`,
      "width: { duration: 0 },",
    ];
    for (const sample of samples) {
      expect(
        TSX_OFF.some(({ pattern }) => pattern.test(sample)),
        sample,
      ).toBe(true);
    }
    expect(TSX_OFF.some(({ pattern }) => pattern.test("duration: 0.12"))).toBe(false);
    for (const sample of [
      "animate={{ rotate: open ? 90 : 0 }}",
      // Concatenated so Tailwind's source scan does not pick the sample up.
      `open && "${"rotate-90"}",`,
    ]) {
      expect(
        TSX_UNGUARDED.some(({ pattern }) => pattern.test(sample)),
        sample,
      ).toBe(true);
    }
    expect(
      TSX_UNGUARDED.some(({ pattern }) => pattern.test('className="-rotate-90 shrink-0"')),
    ).toBe(false);
  });
});
