import { IconCheck, IconFileText } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { PersonalizationState } from "../../../../../shared/contracts";
import type { SettingsTextKey } from "../../../../../shared/settings-text";
import { WorkingText } from "../../../components/ui/WorkingText";
import { useSettingsText } from "../../../lib/settingsText";
import { Disclosure } from "../form-controls";
import {
  ReadOnlyPill,
  SettingsList,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "../settings-layout";

export function PersonalizationSettingsPanel() {
  const t = useSettingsText();
  const [state, setState] = useState<PersonalizationState | undefined>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<SettingsTextKey | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.modus.personalization.get();
      setState(next);
      setDraft(next.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: initial load only; refresh is also used by Open file.
  useEffect(() => {
    void refresh();
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const next = await window.modus.personalization.save({ content: draft });
      setState(next);
      setDraft(next.content);
      setMessage("settings.appearance.saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function openFile(): Promise<void> {
    setError(undefined);
    try {
      await window.modus.personalization.open();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const dirty = state ? draft !== state.content : false;

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-chip px-2.5 text-xs text-fg transition-colors hover:bg-chip-strong disabled:opacity-40"
              disabled={loading || saving}
              onClick={() => void openFile()}
              type="button"
            >
              <IconFileText size={14} stroke={1.7} />
              {t("settings.appearance.openFile")}
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-on-accent text-xs transition-colors hover:bg-accent/90 disabled:opacity-40"
              disabled={!dirty || loading || saving}
              onClick={() => void save()}
              type="button"
            >
              <IconCheck size={13} stroke={2} />
              {saving ? (
                <WorkingText className="text-on-accent">
                  {t("settings.appearance.saving")}
                </WorkingText>
              ) : (
                t("settings.appearance.save")
              )}
            </button>
          </>
        }
        title={t("settings.appearance.personalizationTitle")}
      />

      {error ? <p className="-mt-4 text-danger text-xs">{error}</p> : null}
      {message ? <p className="-mt-4 text-success text-xs">{t(message)}</p> : null}

      <SettingsSection title={t("settings.appearance.customInstructions")}>
        <textarea
          className="scroll-thin min-h-[320px] resize-y settings-group px-4 py-3 font-mono text-sm text-fg leading-6 outline-none placeholder:text-fg-faint focus:border-focus-ring/60 focus:ring-2 focus:ring-focus-ring/35 disabled:opacity-60"
          disabled={loading}
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage(undefined);
          }}
          placeholder={t("settings.appearance.customInstructionsPlaceholder")}
          value={loading ? "" : draft}
        />
      </SettingsSection>

      {state ? (
        <Disclosure label={t("settings.appearance.instructionFiles")}>
          <SettingsList>
            <SettingsRow
              control={
                <ReadOnlyPill>
                  {state.overrideActive
                    ? t("settings.appearance.fileOverride")
                    : t("settings.appearance.fileBase")}
                </ReadOnlyPill>
              }
              notice={state.activePath}
              title={t("settings.appearance.activeFile")}
            />
            <SettingsRow
              control={
                <ReadOnlyPill>
                  {state.overrideActive
                    ? t("settings.appearance.statusActive")
                    : t("settings.appearance.statusInactive")}
                </ReadOnlyPill>
              }
              notice={state.overridePath}
              title={t("settings.appearance.agentsOverrideTitle")}
            />
          </SettingsList>
        </Disclosure>
      ) : null}
    </>
  );
}
