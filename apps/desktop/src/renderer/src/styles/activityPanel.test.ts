import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Activity panel = one borderless glass surface (Grok/Gabriel rules). The shared
 * chrome (.timeline-wire, bordered bg-card boxes) is neutralised only under
 * .activity-panel, so other surfaces keep theirs.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("./app.css");

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} exists`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

describe("Activity panel glass", () => {
  it("the panel itself has no header row or divider", () => {
    const src = read("../features/agent/ActivityTimeline.tsx");
    expect(src).not.toMatch(/<header|border-b|Execution history|No execution activity/);
    expect(src).toContain('className="activity-panel ');
    expect(src).toContain("data-event-count={events.length}");
  });

  it("every bordered box rendered inside Activity opts into the scoped inset/divider", () => {
    const boxes: Array<[string, RegExp, string]> = [
      [
        "../features/agent/ToolCard.tsx",
        /border-hairline border-t px-3 py-2/,
        "data-activity-divider",
      ],
      [
        "../features/agent/ToolCard.tsx",
        /rounded-md border border-hairline bg-card px-3 py-2/,
        "data-activity-inset",
      ],
      [
        "../features/agent/diff/DiffToolCard.tsx",
        /rounded-md border border-hairline bg-card/,
        "data-activity-inset",
      ],
      [
        "../features/agent/terminal/TerminalToolCard.tsx",
        /rounded-lg border bg-card/,
        "data-activity-inset",
      ],
      [
        "../features/agent/SearchToolCard.tsx",
        /rounded-md border border-hairline bg-card/,
        "data-activity-inset",
      ],
      [
        "../features/agent/SearchToolCard.tsx",
        /border-hairline border-b px-2\.5/,
        "data-activity-divider",
      ],
      [
        "../features/agent/SearchToolCard.tsx",
        /border-hairline border-t px-2\.5/,
        "data-activity-divider",
      ],
      [
        "../features/agent/diff/InlineDiff.tsx",
        /border-hairline-soft border-t/,
        "data-activity-divider",
      ],
    ];
    for (const [path, box, attr] of boxes) {
      const src = read(path);
      const at = src.search(box);
      expect(at, `${path}: ${box}`).toBeGreaterThan(-1);
      // The attribute sits on the same JSX element, before its opening tag closes.
      const attrAt = src.indexOf(attr, at);
      expect(attrAt, `${path} ${attr}`).toBeGreaterThan(at);
      expect(attrAt - at, `${path} ${attr} nearby`).toBeLessThan(400);
      const element = src.slice(at, src.indexOf("\n", attrAt) + 1);
      expect(element.match(/<[a-z]/g) ?? [], `${path} ${attr} same element`).toEqual([]);
    }
  });

  it("scoped rules remove borders and dividers and keep a soft inset fill", () => {
    const inset = rule(".activity-panel .timeline-wire,\n.activity-panel [data-activity-inset]");
    expect(inset).toMatch(/border-width: 0/);
    expect(inset).toMatch(/background-color: var\(--activity-inset-bg\)/);
    expect(rule(".activity-panel [data-activity-divider]")).toMatch(/border-width: 0/);
    expect(rule('.activity-panel [data-activity-inset="error"]')).toMatch(
      /--activity-inset-error-bg/,
    );
    expect(rule(".activity-panel")).toMatch(/--tool-group-mask-from: var\(--surface-sidebar\)/);
    // Light glass lightens the inset (a darker fill dropped faint text below 4.5:1).
    expect(rule(':root:not([data-theme="dark"]) .activity-panel')).toMatch(
      /--activity-inset-bg: color-mix\(in srgb, #fff 60%, transparent\)/,
    );
  });

  it("the shared .timeline-wire chrome is unchanged outside Activity", () => {
    expect(rule(".timeline-wire")).toMatch(/border: 1px solid var\(--color-hairline\)/);
  });

  it("the streaming mask fades from the panel surface, not the canvas", () => {
    expect(read("../features/agent/ToolGroup.tsx")).toContain(
      "from-[var(--tool-group-mask-from,var(--color-canvas))]",
    );
  });
});
