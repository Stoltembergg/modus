import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(desktopDir, "../..");
const uiDir = "apps/desktop/src/renderer/src/components/ui";

// ShinyText.tsx is adapted from React Bits "Shiny Text" but has no source header.
const REACT_BITS_WITHOUT_HEADER = ["ShinyText.tsx"];

function reactBitsSection(): string {
  const notices = readFileSync(join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  const start = notices.indexOf("## React Bits");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = notices.indexOf("\n## ", start + 1);
  return notices.slice(start, end === -1 ? undefined : end);
}

function listedComponentFiles(): string[] {
  const listed = reactBitsSection().match(/`apps\/desktop\/[^`]+\.tsx`/g) ?? [];
  return listed.map((path) => path.slice(1, -1)).sort();
}

function reactBitsFilesInUi(): string[] {
  return readdirSync(join(repoRoot, uiDir))
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .filter(
      (name) =>
        REACT_BITS_WITHOUT_HEADER.includes(name) ||
        /react ?bits|reactbits\.dev/i.test(readFileSync(join(repoRoot, uiDir, name), "utf8")),
    )
    .map((name) => `${uiDir}/${name}`)
    .sort();
}

describe("THIRD_PARTY_NOTICES.md React Bits entry", () => {
  it("lists only component files that still exist", () => {
    for (const path of listedComponentFiles()) {
      expect(existsSync(join(repoRoot, path)), path).toBe(true);
    }
  });

  it("lists every React Bits component file in components/ui", () => {
    expect(listedComponentFiles()).toEqual(reactBitsFilesInUi());
  });
});
