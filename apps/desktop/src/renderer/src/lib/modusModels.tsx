import type { ModusModelsStatus } from "../../../shared/contracts";

/**
 * Modus models in the renderer pickers (Settings default model, AgentDialog, NewGroupModal,
 * CreateGroupDialog) and the "Modus unavailable" notice.
 * - The pickers list models grouped by provider (`buildModelPickerGroups`): the Modus group
 *   first, then one group per user provider, alphabetical by the name Settings › Providers
 *   shows (ModelInfo.providerName).
 * - A locked Modus model (router `/v1/models` `allowed: false`, ModelInfo.locked) is not
 *   listed at all. The main process still rejects it (setDefaultModel, isModelAvailable).
 *   Only `modus/…` ids can be hidden: a BYOK provider's model is always listed.
 * - A saved model that is no longer listed (locked, or its provider went away) stays as a
 *   loose "<name or id> (unavailable)" option, so the saved value never changes silently.
 */

/** Registry ids of the Modus provider are `modus/<provider>/<id>` (main MODUS_PROVIDER_ID). */
export const MODUS_MODEL_PREFIX = "modus/";

const MODUS_PROVIDER_ID = "modus";
const MODUS_GROUP_LABEL = "Modus";

export function isModusModelId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(MODUS_MODEL_PREFIX);
}

export type PickableModel = {
  id: string;
  name: string;
  /** Registry provider id (ModelInfo.provider); else the `<providerId>/` id prefix. */
  provider?: string | undefined;
  /** The provider's name as Settings › Providers shows it (ModelInfo.providerName). */
  providerName?: string | undefined;
  locked?: boolean | undefined;
};

export type ModelPickerGroup<M extends PickableModel = PickableModel> = {
  /** Registry provider id (`modus` for the Modus group), e.g. for ProviderLogo. */
  providerId: string;
  label: string;
  models: M[];
};

export type ModelPickerGroups<M extends PickableModel = PickableModel> = {
  /** Options outside any group, before the groups: the saved model that is no longer listed. */
  loose: { id: string; label: string }[];
  groups: ModelPickerGroup<M>[];
};

/**
 * Whether the model came from the Modus router catalog. Decided by origin (ModelInfo.provider,
 * the registry provider), not by the id: a Modus model's router id can equal a bundled/BYOK id
 * (`deepseek/deepseek-flash`). The `modus/` prefix is only a fallback when provider is missing.
 */
export function isModusModel(model: PickableModel): boolean {
  return model.provider ? model.provider === MODUS_PROVIDER_ID : isModusModelId(model.id);
}

/** Hidden from the pickers: a locked Modus model. A BYOK model is never hidden. */
export function isHiddenPickerModel(model: PickableModel): boolean {
  return Boolean(model.locked) && isModusModel(model);
}

/** The models a picker offers (and that a draft may pick), in the given order. */
export function selectableModels<M extends PickableModel>(models: readonly M[]): M[] {
  return models.filter((model) => !isHiddenPickerModel(model));
}

function providerIdOf(model: PickableModel): string {
  if (model.provider) return model.provider;
  if (isModusModelId(model.id)) return MODUS_PROVIDER_ID;
  const slash = model.id.indexOf("/");
  return slash > 0 ? model.id.slice(0, slash) : model.id;
}

/**
 * The picker content: hides locked Modus models, groups the rest by provider (Modus first,
 * then the user's providers alphabetical by display name; empty groups dropped; the given
 * order kept inside a group) and keeps `savedModelId` as a loose "(unavailable)" option
 * when it is not among the listed models. Callers render their own placeholder /
 * "App default" option before `loose`.
 */
export function buildModelPickerGroups<M extends PickableModel>(
  models: readonly M[],
  savedModelId?: string | null,
): ModelPickerGroups<M> {
  const visible = selectableModels(models);
  const byProvider = new Map<string, ModelPickerGroup<M>>();
  for (const model of visible) {
    const providerId = providerIdOf(model);
    let group = byProvider.get(providerId);
    if (!group) {
      const label =
        providerId === MODUS_PROVIDER_ID ? MODUS_GROUP_LABEL : model.providerName || providerId;
      group = { providerId, label, models: [] };
      byProvider.set(providerId, group);
    }
    group.models.push(model);
  }
  const groups = [...byProvider.values()].sort(
    (a, b) =>
      Number(b.providerId === MODUS_PROVIDER_ID) - Number(a.providerId === MODUS_PROVIDER_ID) ||
      a.label.localeCompare(b.label) ||
      a.providerId.localeCompare(b.providerId),
  );
  const loose: ModelPickerGroups<M>["loose"] = [];
  if (savedModelId && !visible.some((model) => model.id === savedModelId)) {
    const known = models.find((model) => model.id === savedModelId);
    loose.push({ id: savedModelId, label: `${known?.name ?? savedModelId} (unavailable)` });
  }
  return { loose, groups };
}

/** `<option>`s / `<optgroup>`s of a native model `<select>` (see buildModelPickerGroups). */
export function ModelOptions({
  models,
  savedModelId,
}: {
  models: readonly PickableModel[];
  savedModelId?: string | null | undefined;
}) {
  const { loose, groups } = buildModelPickerGroups(models, savedModelId);
  return (
    <>
      {loose.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
      {groups.map((group) => (
        <optgroup data-provider={group.providerId} key={group.providerId} label={group.label}>
          {group.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

/** The inline "Modus unavailable" notice applies only to a session on a Modus model. */
export function showsModusUnavailable(
  status: ModusModelsStatus | undefined,
  modelIds: readonly (string | null | undefined)[],
): boolean {
  return status === "unavailable" && modelIds.some(isModusModelId);
}
