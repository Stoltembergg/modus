import type { ModusModelsStatus } from "../../../shared/contracts";
import { modusText } from "../../../shared/modus-text";

/**
 * L3b0: Modus models in the renderer pickers (Settings default model, AgentDialog,
 * NewGroupModal, CreateGroupDialog) and the "Modus unavailable" notice.
 * - A locked model (router `/v1/models` `allowed: false`, ModelInfo.locked) is listed with a
 *   lock and the unlock text, but choosing it never selects it: it opens Buy credits
 *   (Settings › Account) instead. The main process rejects it too (setDefaultModel,
 *   isModelAvailable).
 * - Unlock text is generic: `/v1/models` only says "not in your plan", not which pack unlocks.
 */

/** Registry ids of the Modus provider are `modus/<provider>/<id>` (main MODUS_PROVIDER_ID). */
export const MODUS_MODEL_PREFIX = "modus/";

export function isModusModelId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(MODUS_MODEL_PREFIX);
}

export type PickableModel = { id: string; name: string; locked?: boolean | undefined };

export function modelOptionLabel(model: PickableModel, locale?: string | null): string {
  return model.locked
    ? `🔒 ${model.name} · ${modusText("modus.locked.unlock", locale)}`
    : model.name;
}

/** `<option>`s for a native model `<select>`; locked ones carry `data-locked`. */
export function ModelOptions({
  models,
  locale,
}: {
  models: readonly PickableModel[];
  locale?: string | null | undefined;
}) {
  return (
    <>
      {models.map((model) => (
        <option
          aria-label={
            model.locked
              ? modusText("modus.locked.buyCredits", locale, { model: model.name })
              : undefined
          }
          data-locked={model.locked ? "" : undefined}
          key={model.id}
          value={model.id}
        >
          {modelOptionLabel(model, locale)}
        </option>
      ))}
    </>
  );
}

let buyCreditsHandler: (() => void) | undefined;

/** App registers the existing Buy credits flow (Settings › Account › credit packs). */
export function setBuyCreditsHandler(handler: (() => void) | undefined): void {
  buyCreditsHandler = handler;
}

export function openBuyCredits(): void {
  buyCreditsHandler?.();
}

/**
 * A picker's change handler: a locked model is NOT selected; it opens Buy credits
 * (`onLocked`, default the app handler). Anything else goes to `select`.
 */
export function pickModel(
  models: readonly PickableModel[],
  id: string,
  select: (id: string) => void,
  onLocked: () => void = openBuyCredits,
): void {
  if (models.find((model) => model.id === id)?.locked) {
    onLocked();
    return;
  }
  select(id);
}

/** The inline "Modus unavailable" notice applies only to a session on a Modus model. */
export function showsModusUnavailable(
  status: ModusModelsStatus | undefined,
  modelIds: readonly (string | null | undefined)[],
): boolean {
  return status === "unavailable" && modelIds.some(isModusModelId);
}
