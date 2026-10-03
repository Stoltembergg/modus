// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The inline <script> in index.html that paints the first frame before React. */
const html = readFileSync(`${import.meta.dirname}/../../index.html`, "utf8");
const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

function runFirstFrame(modus: unknown, storedTheme: string | null = "dark") {
  const root = document.documentElement;
  for (const key of Object.keys(root.dataset)) delete root.dataset[key];
  window.localStorage.clear();
  if (storedTheme) window.localStorage.setItem("modus.theme", storedTheme);
  vi.stubGlobal("modus", modus);
  // Runs the shipped inline bootstrap verbatim, in global scope like the page does.
  new Function(inline)();
  return { ...root.dataset };
}

const appWith = (glassMode: "full" | "sidebar" | "off") => ({
  app: {
    nativeGlass: true,
    isNativeGlassAvailable: () => glassMode !== "off",
    appearance: { initial: { glassMode, glass: glassMode !== "off" } },
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("index.html first frame (D2)", () => {
  it("follows the stored Transparency mode in every theme, light included", () => {
    expect(inline).toContain("glassMode");
    for (const theme of ["dark", "dark-plus", "light"]) {
      for (const mode of ["full", "sidebar", "off"] as const) {
        expect(runFirstFrame(appWith(mode), theme)).toMatchObject({
          theme,
          nativeGlass: String(mode !== "off"),
          transparency: mode,
        });
      }
    }
  });

  it("never forces the light theme solid", () => {
    expect(inline).not.toMatch(/!==\s*"light"/);
    expect(runFirstFrame(appWith("sidebar"), "light")).toMatchObject({
      nativeGlass: "true",
      transparency: "sidebar",
    });
  });

  it("falls back to Sidebar with glass and to Off without it when main sent no state", () => {
    expect(
      runFirstFrame({ app: { nativeGlass: true, isNativeGlassAvailable: () => true } }),
    ).toMatchObject({ nativeGlass: "true", transparency: "sidebar" });
    expect(runFirstFrame(undefined)).toMatchObject({ nativeGlass: "false", transparency: "off" });
  });
});
