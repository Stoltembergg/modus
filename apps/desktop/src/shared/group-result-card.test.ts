import { describe, expect, it } from "vitest";
import {
  consolidateGroupFinalResult,
  formatGroupFinalResultCard,
  isGroupFinalResultCard,
  parseGroupFinalResultCard,
} from "./group-result-card";

describe("group-result-card", () => {
  it("parses Outcome plus supporting sections into a final card", () => {
    const body = [
      "Done — symlink escapes are blocked.",
      "",
      "Outcome: Block workspace symlink escapes",
      "Validations:",
      "- typecheck passed",
      "- unit tests green",
      "Changed files:",
      "- apps/desktop/src/foo.ts",
      "- apps/desktop/src/foo.test.ts",
      "Open items:",
      "- Confirm Windows path casing",
    ].join("\n");

    const parsed = parseGroupFinalResultCard(body);
    expect(parsed?.prose).toBe("Done — symlink escapes are blocked.");
    expect(parsed?.card).toEqual({
      outcome: "Block workspace symlink escapes",
      validations: ["typecheck passed", "unit tests green"],
      changedFiles: ["apps/desktop/src/foo.ts", "apps/desktop/src/foo.test.ts"],
      openItems: ["Confirm Windows path casing"],
    });
    expect(isGroupFinalResultCard(body)).toBe(true);
  });

  it("rejects Outcome-only bodies (need validations, files, or open items)", () => {
    expect(parseGroupFinalResultCard("Outcome: Shipped the toggle")).toBeUndefined();
    expect(isGroupFinalResultCard("Outcome: Shipped the toggle")).toBe(false);
  });

  it("round-trips format → parse for consolidated cards", () => {
    const card = consolidateGroupFinalResult({
      outcome: "Ship dark mode",
      validations: ["visual check ok"],
      changedFiles: ["theme.css"],
      openItems: [],
    });
    const body = formatGroupFinalResultCard(card);
    expect(body).toContain("Outcome: Ship dark mode");
    expect(body).toContain("Validations: visual check ok");
    expect(body).toContain("Changed files: theme.css");
    expect(body).not.toContain("Open items");
    expect(parseGroupFinalResultCard(body)?.card).toEqual(card);
  });
});
