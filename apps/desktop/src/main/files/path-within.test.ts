import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWithin } from "./path-within";

describe("resolveWithin", () => {
  // Use a well-known absolute base that works cross-platform
  const root = resolve("my-workspace");

  it("resolves relative paths within the root directory", () => {
    expect(resolveWithin(root, "src/index.ts")).toBe(resolve(root, "src/index.ts"));
    expect(resolveWithin(root, "./package.json")).toBe(resolve(root, "package.json"));
    expect(resolveWithin(root, "dir/../file.txt")).toBe(resolve(root, "file.txt"));
  });

  it("resolves absolute paths within the root directory", () => {
    const target = resolve(root, "src/index.ts");
    expect(resolveWithin(root, target)).toBe(target);
  });

  it("returns the root directory when target matches root", () => {
    expect(resolveWithin(root, "")).toBe(root);
    expect(resolveWithin(root, ".")).toBe(root);
    expect(resolveWithin(root, root)).toBe(root);
  });

  it("throws when a relative path escapes the root", () => {
    expect(() => resolveWithin(root, "../outside")).toThrow(
      "Refusing to access a path outside the workspace.",
    );
    expect(() => resolveWithin(root, "src/../../outside")).toThrow(
      "Refusing to access a path outside the workspace.",
    );
  });

  it("throws when an absolute path escapes the root", () => {
    const target = resolve(root, "..", "outside-file.txt");
    expect(() => resolveWithin(root, target)).toThrow(
      "Refusing to access a path outside the workspace.",
    );
  });
});
