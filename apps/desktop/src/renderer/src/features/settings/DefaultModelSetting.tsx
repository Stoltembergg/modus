import type { ModelInfo } from "../../../../shared/contracts";
import { modelOptionLabel, pickModel } from "../../lib/modusModels";
import { SettingsList, SettingsRow } from "./settings-layout";

/**
 * L3b0: the Settings default model (the model every 1:1 turn runs on, L2b). Grouped by
 * provider; a locked Modus model shows a lock and the unlock text, and choosing it opens
 * Buy credits instead of selecting it.
 */
export function DefaultModelSetting({
  models,
  defaultModel,
  busy,
  onSetDefaultModel,
  onBuyCredits,
}: {
  models: readonly ModelInfo[];
  defaultModel: string | undefined;
  busy?: boolean;
  onSetDefaultModel(modelId: string): void;
  onBuyCredits(): void;
}) {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const name = model.providerName ?? model.provider;
    groups.set(name, [...(groups.get(name) ?? []), model]);
  }
  const pickable = models.map((model) => ({
    id: model.id,
    name: model.name,
    locked: Boolean(model.locked),
  }));
  return (
    <SettingsList>
      <SettingsRow
        control={
          <select
            aria-label="Default model"
            className="h-8 max-w-[320px] rounded-md border border-hairline bg-canvas px-2 text-sm text-fg outline-none focus:border-hairline-strong"
            disabled={busy || models.length === 0}
            onChange={(event) =>
              pickModel(pickable, event.target.value, onSetDefaultModel, onBuyCredits)
            }
            value={defaultModel ?? ""}
          >
            {defaultModel ? null : (
              <option disabled value="">
                {models.length === 0 ? "No model configured" : "Choose a model"}
              </option>
            )}
            {[...groups].map(([provider, items]) => (
              <optgroup key={provider} label={provider}>
                {items.map((model) => (
                  <option
                    data-locked={model.locked ? "" : undefined}
                    key={model.id}
                    value={model.id}
                  >
                    {modelOptionLabel({ ...model, locked: Boolean(model.locked) })}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        }
        description="Every new message runs on this model."
        title="Default model"
      />
    </SettingsList>
  );
}
