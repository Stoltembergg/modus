import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(desktopDir, "../..");
const rendererDir = join(desktopDir, "src/renderer/src");
const uiDir = join(rendererDir, "components/ui");

// The upstream mark, assembled so this guard does not itself carry it.
const MARK = new RegExp(["react", "[\\s-]?", "bits"].join(""), "i");

// L0 (clean-room): the ten adapted components were deleted and rewritten from specs.
// None of these names may come back anywhere in the renderer.
const REMOVED_COMPONENTS = [
  "Aurora",
  "BranchedMenu",
  "FadeContent",
  "GradientWaves",
  "PromptSendGlyph",
  "ScrollReveal",
  "ShinyText",
  "SpringCheck",
  "TextType",
  "ThoughtLine",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("no third-party component marks left in components/ui", () => {
  it("no file under components/ui carries the upstream mark", () => {
    const marked = walk(uiDir)
      .filter((path) => MARK.test(read(path)))
      .map((path) => relative(repoRoot, path));
    expect(marked).toEqual([]);
  });

  it("the removed component files do not come back (any extension, any folder)", () => {
    const names = new Set(REMOVED_COMPONENTS);
    const back = walk(rendererDir)
      .filter((path) => names.has((path.split("/").pop() ?? "").split(".")[0] ?? ""))
      .map((path) => relative(repoRoot, path));
    expect(back).toEqual([]);
  });

  it("nothing imports a removed component", () => {
    const importOf = new RegExp(`/(${REMOVED_COMPONENTS.join("|")})["']`);
    const offenders = walk(join(desktopDir, "src"))
      .filter((path) => /\.(ts|tsx|mts|mjs)$/.test(path))
      .filter((path) => importOf.test(read(path)))
      .map((path) => relative(repoRoot, path));
    expect(offenders).toEqual([]);
  });

  it("app.css has no rules marked with the upstream name", () => {
    expect(read(join(rendererDir, "styles/app.css"))).not.toMatch(MARK);
  });
});

describe("license files after L0", () => {
  it("LICENSE is the plain Apache-2.0 text with no third-party exception block", () => {
    const license = read(join(repoRoot, "LICENSE"));
    expect(license.trimStart().startsWith("Apache License")).toBe(true);
    expect(license).toContain("http://www.apache.org/licenses/LICENSE-2.0");
    expect(license.trimEnd().endsWith("limitations under the License.")).toBe(true);
    expect(license).not.toContain("THIRD-PARTY FILES NOT COVERED");
    expect(license).not.toMatch(MARK);
    expect(license).not.toContain("Commons Clause");
  });

  it.each(["README.md", "README.zh-CN.md"])("%s License section is plain Apache-2.0", (readme) => {
    const text = read(join(repoRoot, readme));
    const start = text.indexOf("## License");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf("\n## ", start + 1);
    const section = text.slice(start, end === -1 ? undefined : end);
    expect(section).toContain("Apache-2.0");
    expect(section).not.toMatch(MARK);
    expect(section).not.toContain("Commons Clause");
    expect(section).not.toMatch(/components\/ui\//);
  });

  it("THIRD_PARTY_NOTICES.md keeps Agent Elements and drops the removed entry", () => {
    const notices = read(join(repoRoot, "THIRD_PARTY_NOTICES.md"));
    expect(notices).toContain("## Agent Elements (21st.dev)");
    expect(notices).not.toMatch(MARK);
    expect(notices).not.toContain("Commons Clause");
    for (const path of notices.match(/`apps\/desktop\/[^`]+`/g) ?? []) {
      expect(existsSync(join(repoRoot, path.slice(1, -1))), path).toBe(true);
    }
  });
});
