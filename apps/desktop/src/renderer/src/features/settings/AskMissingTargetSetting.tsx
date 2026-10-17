import { useEffect, useState } from "react";
import { useSettingsText } from "../../lib/settingsText";
import { SwitchControl } from "./form-controls";

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
    <section className="mt-6 rounded-lg bg-panel px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-md font-normal text-fg">{title}</h3>
          <p className="mt-1 text-xs text-fg-faint">{t("settings.general.askMissingTargetDesc")}</p>
          {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
        </div>
        <SwitchControl
          ariaLabel={title}
          checked={enabled}
          disabled={saving}
          onCheckedChange={(checked) => void toggle(checked)}
        />
      </div>
    </section>
  );
}
