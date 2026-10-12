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
    expect(createAppearanceStore(dir).read()).toEqual({
      theme: "dark",
      transparency: "sidebar",
      look: "classic",
    });
    writeFileSync(join(dir, APPEARANCE_FILE_NAME), "not json");
    expect(createAppearanceStore(dir).read()).toEqual({
      theme: "dark",
      transparency: "sidebar",
      look: "classic",
    });
  });

  it("migrates a legacy `auto` to `sidebar` per field, keeps the theme and rewrites the file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, APPEARANCE_FILE_NAME), '{"theme":"light","transparency":"auto"}');
    expect(createAppearanceStore(dir).read()).toEqual({
      theme: "light",
      transparency: "sidebar",
      look: "classic",
    });
    expect(onDisk(dir)).toEqual({
      theme: "light",
      transparency: "sidebar",
      look: "classic",
    });
  });

  it("resets only the invalid field to its default", () => {
    expect(migrateAppearancePreferences({ theme: "dark-plus", transparency: "on" })).toEqual({
      theme: "dark-plus",
      transparency: "sidebar",
      look: "classic",
    });
    expect(migrateAppearancePreferences({ theme: "neon", transparency: "full" })).toEqual({
      theme: "dark",
      transparency: "full",
      look: "classic",
    });
    for (const raw of [null, 42, "x", [], {}]) {
      expect(migrateAppearancePreferences(raw)).toEqual({
        theme: "dark",
        transparency: "sidebar",
        look: "classic",
      });
    }
  });

  it("keeps a valid look, and falls back to classic on invalid/missing look without resetting theme or transparency", () => {
    expect(
      migrateAppearancePreferences({ theme: "light", transparency: "full", look: "new" }),
    ).toEqual({
      theme: "light",
      transparency: "full",
      look: "new",
    });
    expect(
      migrateAppearancePreferences({ theme: "light", transparency: "full", look: "invalid" }),
    ).toEqual({
      theme: "light",
      transparency: "full",
      look: "classic",
    });
    expect(migrateAppearancePreferences({ theme: "light", transparency: "full" })).toEqual({
      theme: "light",
      transparency: "full",
      look: "classic",
    });
  });

  it("round-trips preferences and leaves an already valid file untouched", () => {
    const dir = tempDir();
    createAppearanceStore(dir).write({ theme: "light", transparency: "off", look: "classic" });
    const before = readFileSync(join(dir, APPEARANCE_FILE_NAME), "utf8");
    expect(createAppearanceStore(dir).read()).toEqual({
      theme: "light",
      transparency: "off",
      look: "classic",
    });
    expect(readFileSync(join(dir, APPEARANCE_FILE_NAME), "utf8")).toBe(before);
  });

  it("keeps the explicit-Transparency flag only when it is literally true", () => {
    const picked = {
      theme: "dark",
      transparency: "sidebar",
      look: "new",
      transparencyChosen: true,
    };
    expect(migrateAppearancePreferences(picked)).toEqual(picked);
    for (const flag of [false, "true", 1]) {
      expect(migrateAppearancePreferences({ ...picked, transparencyChosen: flag })).toEqual({
        theme: "dark",
        transparency: "sidebar",
        look: "new",
      });
    }
  });
});
