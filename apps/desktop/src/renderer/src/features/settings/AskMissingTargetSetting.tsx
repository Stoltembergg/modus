import { useEffect, useState } from "react";
import { useSettingsText } from "../../lib/settingsText";
import { SwitchControl } from "./form-controls";
import { SettingsRow } from "./settings-layout";

/**
 * Build mode asks one question when an edit request names nothing to change ("Fix it").
 * Turning this off makes the agent proceed directly. It never changes the model, the
 * reasoning level or the available tools, and destructive-action confirmation stays on.
 */
export function AskMissingTargetSetting() {
  const t = useSettingsText();
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const title = t("settings.general.askMissingTargetTitle");

  useEffect(() => {
    let cancelled = false;
    window.modus.permission
      .getAskMissingTarget()
      .then((value: boolean) => {
        if (!cancelled) setEnabled(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      setEnabled(await window.modus.permission.setAskMissingTarget({ enabled: next }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow
      control={
        <SwitchControl
          ariaLabel={title}
          checked={enabled}
          disabled={saving}
          onCheckedChange={(checked) => void toggle(checked)}
        />
      }
      notice={error}
      noticeTone="danger"
      title={title}
    />
  );
}
