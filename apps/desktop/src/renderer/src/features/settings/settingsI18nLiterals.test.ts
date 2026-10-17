import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { scanUntranslated } from "./settingsI18nScan";

/**
 * Guard for the Settings / question card translation: every user-visible
 * string in these files must come from the settings catalog
 * (`shared/settings-text.ts`, via `useSettingsText`). The scan parses each
 * file and fails on English text written straight into what renders: JSX
 * text, string props that are read by people or screen readers, and string
 * literals placed as JSX children (`{busy ? "Saving…" : "Save"}`).
 */
const RENDERER = join(__dirname, "../..");

const FILES = [
  "features/settings/SettingsPanel.tsx",
  "features/settings/settings-layout.tsx",
  "features/settings/sections/SettingsSidebar.tsx",
  "features/settings/form-controls.tsx",
  "features/settings/sections/general.tsx",
  "features/settings/ApprovalModeSettings.tsx",
  "features/settings/AskMissingTargetSetting.tsx",
  "features/settings/sections/account.tsx",
  "features/settings/sections/account-billing.tsx",
  "features/settings/sections/model-provider.tsx",
  "features/settings/DefaultModelSetting.tsx",
  "features/settings/UnofficialProviderNotice.tsx",
  "features/settings/CustomProviderForm.tsx",
  "features/settings/settings-provider-ui.tsx",
  "features/settings/sections/appearance.tsx",
  "features/settings/sections/personalization.tsx",
  "features/settings/sections/mcp.tsx",
  "features/settings/sections/integrations.tsx",
  "features/settings/sections/skills.tsx",
  "features/settings/sections/rules.tsx",
  "components/question/QuestionCard.tsx",
  "features/agent/QuestionToolCard.tsx",
] as const;

describe("Settings and question card copy comes from the i18n catalog", () => {
  it.each(FILES)("%s renders no hardcoded English", (file) => {
    const path = join(RENDERER, file);
    const findings = scanUntranslated(relative(RENDERER, path), readFileSync(path, "utf8"));
    expect(findings.map((f) => `${f.file}:${f.line} ${JSON.stringify(f.text)}`)).toEqual([]);
  });

  it("catches each kind of raw literal (the scan itself works)", () => {
    const sample = [
      'export function X({ busy, okLabel = "OK then" }: { busy: boolean; okLabel?: string }) {',
      "  return (",
      '    <div aria-label="Close panel" className="flex gap-2" data-testid="x">',
      "      Save changes",
      '      {busy ? "Saving…" : t("settings.window.save")}',
      '      <input placeholder={busy ? "Wait" : t("k")} type="text" />',
      '      {"—"} {count} <Icon title={`Open ${name}`} /> <kbd>ESC</kbd> <code>AGENTS.md</code>',
      '      <span className="font-mono text-xs">SKILL.md</span>',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    expect(scanUntranslated("sample.tsx", sample).map((f) => f.text)).toEqual([
      "OK then",
      "Close panel",
      "Save changes",
      "Saving…",
      "Wait",
      "Open",
    ]);
  });
});
