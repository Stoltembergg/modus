import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPEARANCE_FILE_NAME, createAppearanceStore } from "./appearance-store";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "modus-appearance-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("appearance store (userData JSON)", () => {
  it("defaults to dark + Automatic when the file is missing or invalid", () => {
    const dir = tempDir();
    expect(createAppearanceStore(dir).read()).toEqual({ theme: "dark", transparency: "auto" });
    writeFileSync(join(dir, APPEARANCE_FILE_NAME), '{"theme":"neon","transparency":"on"}');
    expect(createAppearanceStore(dir).read()).toEqual({ theme: "dark", transparency: "auto" });
    writeFileSync(join(dir, APPEARANCE_FILE_NAME), "not json");
    expect(createAppearanceStore(dir).read()).toEqual({ theme: "dark", transparency: "auto" });
  });

  it("round-trips preferences through the file", () => {
    const dir = tempDir();
    createAppearanceStore(dir).write({ theme: "light", transparency: "off" });
    expect(JSON.parse(readFileSync(join(dir, APPEARANCE_FILE_NAME), "utf8"))).toEqual({
      theme: "light",
      transparency: "off",
    });
    expect(createAppearanceStore(dir).read()).toEqual({ theme: "light", transparency: "off" });
  });
});
