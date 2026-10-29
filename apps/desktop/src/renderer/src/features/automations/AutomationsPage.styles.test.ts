import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./AutomationsPage.tsx", import.meta.url), "utf8");

describe("Automations glass styling", () => {
  it("has no divider or hairline border utilities", () => {
    expect(source).not.toMatch(/\bdivide-[a-z]/);
    expect(source).not.toMatch(/\bborder(-[xytblr])?\b(?!-)/);
    expect(source).not.toMatch(/\bborder-hairline/);
  });

  it("styles fields on keyboard focus with the shared focus ring, not :focus", () => {
    const field = source.match(/const FIELD_CLASS =\s*"([^"]+)"/)?.[1] ?? "";
    expect(field).toContain("focus-visible:ring-2");
    expect(field).toContain("focus-visible:ring-focus-ring/35");
    expect(field).not.toMatch(/(^|\s)focus:/);
    expect(source).not.toMatch(/(^|[\s"`])focus:/);
  });
});
