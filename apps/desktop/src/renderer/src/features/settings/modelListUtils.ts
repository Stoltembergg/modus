import type { ProviderModelConfig } from "../../../../shared/contracts";
import { type SettingsTextFn, settingsTextFor } from "../../lib/settingsText";

export type ModelGroup = {
  id: string;
  title: string;
  description: string;
  models: ProviderModelConfig[];
};

export function groupProviderModels(
  models: ProviderModelConfig[],
  t: SettingsTextFn = settingsTextFor(),
): ModelGroup[] {
  const enabled = models.filter((model) => model.enabled);
  const thinking = models.filter((model) => !model.enabled && model.reasoning);
  const standard = models.filter((model) => !model.enabled && !model.reasoning);

  return [
    {
      id: "enabled",
      title: t("settings.providers.groupEnabled"),
      description: t("settings.providers.groupEnabledDescription"),
      models: enabled,
    },
    {
      id: "thinking",
      title: t("settings.providers.groupThinking"),
      description: t("settings.providers.groupThinkingDescription"),
      models: thinking,
    },
    {
      id: "standard",
      title: t("settings.providers.groupStandard"),
      description: t("settings.providers.groupStandardDescription"),
      models: standard,
    },
  ].filter((group) => group.models.length > 0);
}

export function modelResultLabel(count: number, t: SettingsTextFn = settingsTextFor()): string {
  return t.plural("settings.providers.modelResultLabel", count);
}
