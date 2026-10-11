import type { ModelInfo } from "../../../../shared/contracts";
import { ModelOptions, selectableModels } from "../../lib/modusModels";
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
  const pickable = models.map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    providerName: model.providerName,
    locked: Boolean(model.locked),
  }));
  const selectable = selectableModels(pickable);
  return (
    <SettingsList>
      <SettingsRow
        control={
          <select
            aria-label="Default model"
            className="h-8 max-w-[320px] rounded-md border border-hairline bg-canvas px-2 text-sm text-fg outline-none focus:border-hairline-strong"
            disabled={busy || selectable.length === 0}
            onChange={(event) => onSetDefaultModel(event.target.value)}
            value={defaultModel ?? ""}
          >
            {defaultModel ? null : (
              <option disabled value="">
                {selectable.length === 0 ? "No model configured" : "Choose a model"}
              </option>
            )}
            <ModelOptions models={pickable} savedModelId={defaultModel} />
          </select>
        }
        description="Every new message runs on this model."
        title="Default model"
      />
    </SettingsList>
  );
}
