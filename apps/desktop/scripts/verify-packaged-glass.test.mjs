import { describe, expect, it } from "vitest";
import { findChrome, renderFailures, verifyPackagedGlass } from "./verify-packaged-glass.mjs";

/**
 * D2 packaged-glass regression. The opt-in suite runs the real verifier on an
 * electron-vite build or an extracted app.asar:
 *   MODUS_PACKAGED_OUT=apps/desktop/out npm run test -w apps/desktop
 * Package macOS / Package Windows run the same verifier as a CLI step.
 */
const OUT = process.env.MODUS_PACKAGED_OUT;

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

  it.skipIf(!OUT)(
    "the build at $MODUS_PACKAGED_OUT passes every packaged glass check",
    async () => {
      if (!findChrome()) throw new Error("packaged glass check needs Chrome");
      const { failures } = await verifyPackagedGlass(OUT);
      expect(failures).toEqual([]);
    },
    60_000,
  );
});
