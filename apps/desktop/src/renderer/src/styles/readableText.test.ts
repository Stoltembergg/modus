import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * #254: text the user has to read to use the app (Settings row and field
 * descriptions, custom provider helpers, empty-room messages, the group kickoff
 * hint, context usage) uses fg-muted, the first text tier that clears 4.5:1 on
 * every glass surface (tokensNew.test.ts, glassTokens.test.ts). fg-faint and
 * fg-subtle stay for auxiliary or disabled text.
 */
const SITES: Record<string, { anchors: string[]; count?: [string, number] }> = {
  "../features/settings/settings-layout.tsx": { anchors: [], count: [">{description}</", 2] },
  "../features/settings/form-controls.tsx": { anchors: [], count: [">{description}</", 3] },
  "../features/settings/CustomProviderForm.tsx": {
    anchors: [
      't("settings.customProvider.description")',
      "t(protocol.hintKey)",
      't("settings.customProvider.customLevelsHint")',
      ">{hint}</p>",
    ],
  },
  "../features/groups/GroupMessageList.tsx": {
    anchors: ['data-testid="group-room-empty"', 'data-testid="group-conversation-search-empty"'],
  },
  "../features/groups/GroupComposer.tsx": { anchors: ['{t("composer.kickoffHint")}'] },
  "../features/composer/Composer.tsx": {
    anchors: [
      "No context usage yet.",
      "Context window {formatUiNumber(usageWindow",
      ">{tokenLine}</div>",
    ],
  },
};

/** className of the JSX element whose opening tag (or direct text) contains `index`. */
function classNameAt(source: string, index: number): string {
  const tag = source.lastIndexOf("<", index);
  const name = source.slice(tag).match(/^<[\w.]+[^>]*?className="([^"]*)"/)?.[1];
  if (name === undefined) throw new Error(`no className before ${source.slice(index, index + 40)}`);
  return name;
}

function occurrences(source: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) out.push(i);
  return out;
}

describe("readable helper text (#254)", () => {
  it("uses fg-muted, never fg-faint or fg-subtle, at the 14 call sites", () => {
    let checked = 0;
    for (const [path, { anchors, count }] of Object.entries(SITES)) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const hits: [string, number][] = anchors.map((anchor) => {
        const at = occurrences(source, anchor);
        expect(at, `${path}: ${anchor} is unique`).toHaveLength(1);
        return [anchor, at[0] as number];
      });
      if (count) {
        const at = occurrences(source, count[0]);
        expect(at, `${path}: ${count[0]}`).toHaveLength(count[1]);
        for (const i of at) hits.push([count[0], i]);
      }
      for (const [anchor, index] of hits) {
        const name = classNameAt(source, index);
        expect(name, `${path}: ${anchor}`).toMatch(/(^|\s)text-fg-muted(\s|$)/);
        expect(name, `${path}: ${anchor}`).not.toMatch(/text-fg-(faint|subtle)/);
        checked += 1;
      }
    }
    // 14 call sites plus the second SettingsRow description, which already used muted.
    expect(checked).toBe(15);
  });
});
