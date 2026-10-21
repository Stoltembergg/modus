import type { ModelInfo } from "../../../../shared/contracts";
import { buildModelPickerGroups, selectableModels } from "../../lib/modusModels";
import { useSettingsText } from "../../lib/settingsText";
import { SelectField } from "./form-controls";
import { SettingsList, SettingsRow } from "./settings-layout";

/**
 * L3b0: the Settings default model (the model every 1:1 turn runs on, L2b). Grouped by
 * provider like every model picker (lib/modusModels buildModelPickerGroups); a locked Modus
 * model is not listed, and a saved default that is no longer listed stays as
 * "<name> (unavailable)" until another model is chosen.
 */
export function DefaultModelSetting({
  models,
  defaultModel,
  busy,
  onSetDefaultModel,
}: {
  models: readonly ModelInfo[];
  defaultModel: string | undefined;
  busy?: boolean;
  onSetDefaultModel(modelId: string): void;
}) {
  const t = useSettingsText();
  const pickable = models.map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    providerName: model.providerName,
    locked: Boolean(model.locked),
  }));
  const selectable = selectableModels(pickable);
  const picker = buildModelPickerGroups(pickable, defaultModel);
  return (
    <SettingsList>
      <SettingsRow
        control={
          <SelectField
            disabled={busy || selectable.length === 0}
            groups={picker.groups.map((group) => ({
              key: group.providerId,
              label: group.label,
              options: group.models.map((model) => ({ label: model.name, value: model.id })),
            }))}
            label={t("settings.providers.defaultModel")}
            labelHidden
            onChange={onSetDefaultModel}
            options={picker.loose.map((option) => ({ label: option.label, value: option.id }))}
            placeholder={
              selectable.length === 0
                ? t("settings.providers.noModelConfigured")
                : t("settings.providers.chooseModel")
            }
            triggerClassName="flex h-8 w-[min(320px,calc(100vw-48px))] min-w-[180px] items-center justify-between gap-2 rounded-md border border-hairline bg-canvas px-2 text-sm text-fg outline-none transition-colors hover:border-hairline-strong focus-visible:border-focus-ring/60 focus-visible:ring-2 focus-visible:ring-focus-ring/35 data-popup-open:border-hairline-strong"
            value={defaultModel}
          />
        }
        title={t("settings.providers.defaultModel")}
      />
    </SettingsList>
  );
}
