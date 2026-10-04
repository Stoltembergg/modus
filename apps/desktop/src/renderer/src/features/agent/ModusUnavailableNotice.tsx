import type { ModusModelsStatus } from "../../../../shared/contracts";
import { modusText } from "../../../../shared/modus-text";
import { showsModusUnavailable } from "../../lib/modusModels";

/**
 * L3b0: inline "Modus unavailable" above the composer, only when this session is on a Modus
 * model (the model the pane sends, or the one stored on the session) and the main process
 * reports the router as unavailable. No modal.
 */
export function ModusUnavailableNotice({
  status,
  modelIds,
}: {
  status: ModusModelsStatus | undefined;
  modelIds: readonly (string | null | undefined)[];
}) {
  if (!showsModusUnavailable(status, modelIds)) return null;
  return (
    <div
      className="mb-2 rounded-lg border border-hairline bg-surface px-3 py-2 text-fg-muted text-xs"
      data-testid="modus-unavailable-notice"
      role="status"
    >
      {modusText("modus.status.unavailableNotice")}
    </div>
  );
}
