import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, optimize } from "@tailwindcss/node";
import { afterAll, describe, expect, it } from "vitest";
import {
  findChrome,
  measureScenarios,
  mediaFor,
  renderFailures,
  SCENARIOS,
  SCENE,
  verifyPackagedGlass,
} from "./verify-packaged-glass.mjs";

/**
 * D2 packaged-glass regression. The opt-in suite runs the real verifier on an
 * electron-vite build or an extracted app.asar:
 *   MODUS_PACKAGED_OUT=apps/desktop/out npm run test -w apps/desktop
 * Package macOS / Package Windows run the same verifier as a CLI step.
 */
const OUT = process.env.MODUS_PACKAGED_OUT;
/** Real checker measurements (before = 8d4c400 build, after = uniform glass build). */
const FIXTURES = JSON.parse(
  readFileSync(new URL("./verify-packaged-glass.fixtures.json", import.meta.url), "utf8"),
);
const CHROME = findChrome();

describe("packaged glass verifier", () => {
  it("flags what Gabriel's macOS build of 152a4c2 measured (opaque <html> hides vibrancy)", () => {
    // 152a4c2 Package macOS artifact (dark, Automatic, glass on): <html> painted the canvas.
    const { measured } = FIXTURES.afterSidebar;
    const failures = renderFailures([
      {
        scenario: { theme: "dark", glass: true, mode: "sidebar" },
        measured: { ...measured, html: 1, rail: 1, sidebar: 1 },
      },
    ]);
    expect(failures).toContain(
      "renderer dark/sidebar/glass=true: <html> background alpha 1 hides the window material",
    );
    expect(failures).toContain(
      "renderer dark/sidebar/glass=true: rail is opaque (effective alpha 1)",
    );
  });

  it("flags the Full build Gabriel saw on 0715072: stacked tints, per-panel blur, dividers", () => {
    // Measured from the electron-vite build of 8d4c400 (= 0715072 + #154), dark / Full.
    expect(renderFailures([FIXTURES.beforeFull])).toEqual([
      "renderer dark/full/glass=true: window tint alpha 0 (expected one translucent layer)",
      "renderer dark/full/glass=true: window layer has no blur",
      "renderer dark/full/glass=true: rail paints its own background (0.78)",
      "renderer dark/full/glass=true: rail has its own backdrop-filter",
      "renderer dark/full/glass=true: sidebar paints its own background (0.78)",
      "renderer dark/full/glass=true: sidebar has its own backdrop-filter",
      "renderer dark/full/glass=true: rail|sidebar divider still visible",
      "renderer dark/full/glass=true: sidebar|main line still visible",
      "renderer dark/full/glass=true: main paints its own background in Full (0.94)",
      "renderer dark/full/glass=true: main 0.94 and rail 0.78 alphas differ in Full",
      "renderer dark/full/glass=true: main edge still visible in Full",
    ]);
  });

  it("accepts uniform glass: one window layer, equal alphas, no dividers, focus ring kept", () => {
    const { afterSidebar, afterFull, afterOff, afterReduced } = FIXTURES;
    expect(renderFailures([afterSidebar, afterFull, afterOff, afterReduced])).toEqual([]);
    expect(afterFull.measured.main).toBe(afterFull.measured.rail);
    expect(afterFull.measured.focusRing).toBe(true);
  });

  it("requires today's dividers and a focus ring when glass is off or the OS asks for solid", () => {
    for (const fixture of [FIXTURES.afterOff, FIXTURES.afterReduced]) {
      const stripped = {
        ...fixture,
        measured: {
          ...fixture.measured,
          edges: { railDivider: 0, mainLeft: 0, mainRight: 0 },
          focusRing: false,
        },
      };
      const failures = renderFailures([stripped]);
      expect(failures.some((f) => f.endsWith("focus ring on a rail item is not visible"))).toBe(
        true,
      );
      expect(failures.filter((f) => f.includes("divider missing"))).toHaveLength(3);
    }
  });

  it("pins the host accessibility media: glass scenarios measure a desktop with every setting off", () => {
    for (const scenario of SCENARIOS.filter((s) => !s.os)) {
      expect(mediaFor(scenario.os)).toEqual([
        { name: "prefers-reduced-transparency", value: "no-preference" },
        { name: "prefers-contrast", value: "no-preference" },
        { name: "forced-colors", value: "none" },
      ]);
    }
    expect(SCENARIOS.map((s) => s.os).filter(Boolean)).toEqual([
      "reduced-transparency",
      "more-contrast",
      "forced-colors",
    ]);
  });

  it("macOS runner (Reduce transparency on): the CSS fallback is expected under `os`, a failure without it", () => {
    // Package macOS run 37147973291: the runner's Reduce transparency turned the
    // solid fallback on in every glass scenario.
    const runner = FIXTURES.afterReduced.measured;
    expect(
      renderFailures([
        { scenario: { theme: "dark", glass: true, mode: "sidebar" }, measured: runner },
      ]).length,
    ).toBeGreaterThanOrEqual(5);
    expect(renderFailures([FIXTURES.afterReduced])).toEqual([]);
  });

  it.skipIf(!OUT)(
    "the build at $MODUS_PACKAGED_OUT passes every packaged glass check",
    async () => {
      if (!findChrome()) throw new Error("packaged glass check needs Chrome");
      const { failures } = await verifyPackagedGlass(OUT);
      expect(failures).toEqual([]);
    },
    60_000,
  );

  describe.skipIf(!CHROME)("in headless Chrome (source index.html + compiled app.css)", () => {
    const dir = mkdtempSync(join(tmpdir(), "modus-glass-renderer-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    async function renderer() {
      const cssPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);
      const compiler = await compile(readFileSync(cssPath, "utf8"), {
        base: new URL(".", cssPath).pathname,
        onDependency: () => undefined,
      });
      // Every utility class the checker's app scene uses (the real build has them all).
      const used = [...SCENE.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
      writeFileSync(join(dir, "app.css"), optimize(compiler.build(used), { minify: true }).code);
      const html = readFileSync(
        new URL("../src/renderer/index.html", import.meta.url),
        "utf8",
      ).replace("</head>", '<link rel="stylesheet" href="./app.css"></head>');
      writeFileSync(join(dir, "index.html"), html);
      return dir;
    }

    it("the verdict does not depend on the host's accessibility settings", async () => {
      const site = await renderer();
      const glass = SCENARIOS.filter((s) => s.glass && !s.os);
      // What the macOS runner did: its Reduce transparency leaked into every glass scenario.
      const leaked = await measureScenarios(
        site,
        CHROME,
        glass.map((s) => ({ ...s, os: "reduced-transparency" })),
      );
      const asIfPlain = leaked.results.map(({ scenario: { os: _os, ...scenario }, measured }) => ({
        scenario,
        measured,
      }));
      expect(renderFailures(asIfPlain).length).toBeGreaterThanOrEqual(glass.length * 5);
      // Pinned (the fix): every scenario, the three OS ones included, passes.
      const pinned = await measureScenarios(site, CHROME);
      expect(renderFailures(pinned.results)).toEqual([]);
    }, 60_000);
  });
});
