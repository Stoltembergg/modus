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

const UI_PATH = /apps\/desktop\/src\/renderer\/src\/components\/ui\/[A-Za-z]+\.tsx/g;

/** React Bits files listed in the LICENSE exception block (after the Apache text). */
function licenseExceptionFiles(): string[] {
  const license = readFileSync(join(repoRoot, "LICENSE"), "utf8");
  const start = license.indexOf("THIRD-PARTY FILES NOT COVERED BY THE APACHE LICENSE ABOVE");
  expect(start).toBeGreaterThan(license.indexOf("limitations under the License."));
  return [...new Set(license.slice(start).match(UI_PATH) ?? [])].sort();
}

/** React Bits files listed under a README's License section. */
function readmeExceptionFiles(readme: string): string[] {
  const text = readFileSync(join(repoRoot, readme), "utf8");
  const start = text.indexOf("## License");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);
  expect(section).toContain("THIRD_PARTY_NOTICES.md");
  expect(section).toContain("MIT + Commons Clause");
  return [...new Set(section.match(UI_PATH) ?? [])].sort();
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

describe("React Bits license marking", () => {
  it("keeps the Apache-2.0 text first and unmodified at the top of LICENSE", () => {
    const license = readFileSync(join(repoRoot, "LICENSE"), "utf8");
    expect(license.trimStart().startsWith("Apache License")).toBe(true);
    expect(license).toContain("http://www.apache.org/licenses/LICENSE-2.0");
  });

  it("LICENSE lists exactly the React Bits files as outside Apache-2.0", () => {
    expect(licenseExceptionFiles()).toEqual(reactBitsFilesInUi());
    expect(licenseExceptionFiles()).toEqual(listedComponentFiles());
  });

  it.each(["README.md", "README.zh-CN.md"])("%s lists exactly the React Bits files", (readme) => {
    expect(readmeExceptionFiles(readme)).toEqual(reactBitsFilesInUi());
  });
});
