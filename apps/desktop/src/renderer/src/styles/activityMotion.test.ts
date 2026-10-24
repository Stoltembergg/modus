import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Activity PR 4: neutral blocked state, motion-safe ping, token timings. */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const agent = (file: string) => read(`../features/agent/${file}`);
const ACTIVITY = [
  "ActivityGroup.tsx",
  "ToolCard.tsx",
  "ToolGroup.tsx",
  "SearchToolCard.tsx",
  "SubagentRow.tsx",
  "TodosCard.tsx",
  "diff/DiffToolCard.tsx",
  "terminal/TerminalToolCard.tsx",
];

describe("Activity status and motion", () => {
  it("draws the blocked subagent dot neutral, never red", () => {
    const row = agent("SubagentRow.tsx");
    const blocked = row.slice(row.indexOf('status === "blocked"'), row.indexOf("return (\n    <span\n"));
    expect(blocked).toContain("bg-fg-muted");
    expect(blocked).not.toContain("danger");
  });

  it("pings only when motion is allowed and is static under reduced motion", () => {
    for (const file of ACTIVITY) {
      for (const line of agent(file).split("\n").filter((l) => l.includes("animate-ping"))) {
        expect(line, file).toContain("hidden");
        expect(line, file).toContain("motion-safe:block motion-safe:animate-ping");
        expect(line, file).not.toMatch(/(^|[\s"])animate-ping/);
      }
    }
  });

  it("marks blocked to-dos with a neutral stop glyph instead of amber", () => {
    const todos = agent("TodosCard.tsx");
    const blocked = todos.slice(todos.indexOf("  blocked: {"), todos.indexOf("};", todos.indexOf("  blocked: {")));
    expect(blocked).toContain("Glyph: IconHandStop");
    expect(blocked).toContain('iconClass: "text-fg-muted"');
    expect(todos).not.toContain("text-warning");
  });

  it("times every Activity transition with motion tokens", () => {
    for (const file of ACTIVITY) {
      const src = agent(file);
      expect(src, file).not.toContain("transition-all");
      expect(src, file).not.toMatch(/duration-\d/);
      for (const cls of src.match(/"[^"]*\btransition-[^"]*"/g) ?? []) {
        expect(cls, file).toMatch(/duration-\(--motion-duration-[a-z]+\)/);
      }
    }
  });

  it("pulses the working thought glyph perceptibly, >= 4.5:1 at its low point, static when reduced", () => {
    const css = read("./app.css").replace(/\s+/g, " ");
    expect(css).toContain(
      "@media (prefers-reduced-motion: no-preference) { .work-status-line__glyph[data-working] { animation: work-status-breathe",
    );
    expect(css).toMatch(/\.work-status-line__glyph\[data-working\] \{ color: var\(--color-fg\);/);
    const low = Number(css.match(/@keyframes work-status-breathe \{.*?50% \{ opacity: ([\d.]+);/)?.[1]);
    // --color-fg at 0.7 over the panel: 5.96 light, 6.9+ dark. Lower would drop under 4.5.
    expect(low).toBeGreaterThanOrEqual(0.7);
    expect(low).toBeLessThanOrEqual(0.75);
  });
});
