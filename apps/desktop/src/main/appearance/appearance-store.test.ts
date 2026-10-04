import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPEARANCE_FILE_NAME,
  createAppearanceStore,
  migrateAppearancePreferences,
} from "./appearance-store";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "modus-appearance-"));
  dirs.push(dir);
  return dir;
};
const onDisk = (dir: string) => JSON.parse(readFileSync(join(dir, APPEARANCE_FILE_NAME), "utf8"));
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("appearance store (userData JSON)", () => {
  it("defaults to dark + Sidebar when the file is missing or not JSON", () => {
    const dir = tempDir();
    expect(createAppearanceStore(dir).read()).toEqual({ theme: "dark", transparency: "sidebar" });
    writeFileSync(join(dir, APPEARANCE_FILE_NAME), "not json");
    expect(createAppearanceStore(dir).read()).toEqual({ theme: "dark", transparency: "sidebar" });
  });

  it("migrates a legacy `auto` to `sidebar` per field, keeps the theme and rewrites the file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, APPEARANCE_FILE_NAME), '{"theme":"light","transparency":"auto"}');
    expect(createAppearanceStore(dir).read()).toEqual({ theme: "light", transparency: "sidebar" });
    expect(onDisk(dir)).toEqual({ theme: "light", transparency: "sidebar" });
  });

  it("resets only the invalid field to its default", () => {
    expect(migrateAppearancePreferences({ theme: "dark-plus", transparency: "on" })).toEqual({
      theme: "dark-plus",
      transparency: "sidebar",
    });
    expect(migrateAppearancePreferences({ theme: "neon", transparency: "full" })).toEqual({
      theme: "dark",
      transparency: "full",
    });
    for (const raw of [null, 42, "x", [], {}]) {
      expect(migrateAppearancePreferences(raw)).toEqual({ theme: "dark", transparency: "sidebar" });
    }
  });

  it("round-trips preferences and leaves an already valid file untouched", () => {
    const dir = tempDir();
    createAppearanceStore(dir).write({ theme: "light", transparency: "off" });
    const before = readFileSync(join(dir, APPEARANCE_FILE_NAME), "utf8");
    expect(createAppearanceStore(dir).read()).toEqual({ theme: "light", transparency: "off" });
    expect(readFileSync(join(dir, APPEARANCE_FILE_NAME), "utf8")).toBe(before);
  });
});
