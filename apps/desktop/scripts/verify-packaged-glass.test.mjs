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
  verifyPackagedGlass,
} from "./verify-packaged-glass.mjs";

/**
 * D2 packaged-glass regression. The opt-in suite runs the real verifier on an
 * electron-vite build or an extracted app.asar:
 *   MODUS_PACKAGED_OUT=apps/desktop/out npm run test -w apps/desktop
 * Package macOS / Package Windows run the same verifier as a CLI step.
 */
const OUT = process.env.MODUS_PACKAGED_OUT;
const CHROME = findChrome();

describe("packaged glass verifier", () => {
  it("flags what Gabriel's macOS build of 152a4c2 measured (opaque <html> hides vibrancy)", () => {
    // Measured from the 152a4c2 Package macOS artifact (dark, Automatic, glass on).
    const failures = renderFailures([
      {
        scenario: { theme: "dark", glass: true, mode: "sidebar" },
        measured: {
          nativeGlass: "true",
          stylesheets: 2,
          html: 1,
          body: 0,
          root: 0,
          shell: 0,
          rail: 1,
          sidebar: 1,
          main: 1,
        },
      },
    ]);
    expect(failures).toEqual([
      "renderer dark/sidebar/glass=true: <html> background alpha 1 hides the window material",
      "renderer dark/sidebar/glass=true: rail is opaque (effective alpha 1)",
      "renderer dark/sidebar/glass=true: sidebar is opaque (effective alpha 1)",
    ]);
  });

  it("accepts a build where the material shows through the left chrome only", () => {
    const failures = renderFailures([
      {
        scenario: { theme: "dark", glass: true, mode: "sidebar" },
        measured: {
          nativeGlass: "true",
          stylesheets: 2,
          html: 0,
          body: 0,
          root: 0,
          shell: 0,
          rail: 0.78,
          sidebar: 0.78,
          main: 1,
        },
      },
      {
        scenario: { theme: "dark", glass: false, mode: "off" },
        measured: {
          nativeGlass: "false",
          stylesheets: 2,
          html: 1,
          body: 0.97,
          root: 0.97,
          shell: 0.97,
          rail: 1,
          sidebar: 1,
          main: 1,
        },
      },
    ]);
    expect(failures).toEqual([]);
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
    // Package macOS run 37147973291 (3dcb1cf), dark/sidebar, host media not pinned.
    const runner = {
      nativeGlass: "true",
      stylesheets: 2,
      html: 0,
      body: 1,
      root: 1,
      shell: 1,
      rail: 1,
      sidebar: 1,
      main: 1,
    };
    expect(
      renderFailures([
        { scenario: { theme: "dark", glass: true, mode: "sidebar" }, measured: runner },
      ]),
    ).toHaveLength(5);
    expect(
      renderFailures([
        {
          scenario: { theme: "dark", glass: true, mode: "sidebar", os: "reduced-transparency" },
          measured: runner,
        },
      ]),
    ).toEqual([]);
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
      const used = [
        "flex",
        "h-screen",
        "min-h-0",
        "min-w-0",
        "flex-1",
        "flex-col",
        "bg-panel",
        "relative",
      ];
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
