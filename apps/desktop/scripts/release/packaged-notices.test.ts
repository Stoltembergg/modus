import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import builderConfig from "../../electron-builder.config";

// electron-builder resolves `from` against apps/desktop (its cwd), two levels up from here.
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(desktopDir, "../..");

type ResourceEntry = { from?: string; to?: string };

function extraResource(to: string): ResourceEntry | undefined {
  const entries = (builderConfig.extraResources ?? []) as ResourceEntry[];
  return entries.find((entry) => typeof entry === "object" && entry.to === to);
}

describe("packaged license notices", () => {
  // MIT (Agent Elements) requires the notice in every copy, so the packaged app ships
  // the repo-root files next to resources/licenses.
  it.each([
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ])("ships the repo-root %s at the top of the app resources", (file) => {
    const entry = extraResource(file);
    expect(entry).toBeDefined();
    const from = resolve(desktopDir, entry?.from ?? "");
    expect(from).toBe(join(repoRoot, file));
    expect(readFileSync(from, "utf8").length).toBeGreaterThan(0);
  });

  it("keeps shipping the vendored MIT licenses directory", () => {
    expect(extraResource("licenses")).toMatchObject({ from: "resources/licenses" });
  });
});
