import { IconAlertTriangle, IconCube } from "@tabler/icons-react";
import { groupModelChipText } from "../../../../shared/group-room-locale";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { MODEL_CHIP_BASE, MODEL_CHIP_TONE } from "../composer/modelChipStyle";
import type { GroupModelChip as GroupModelChipData } from "./groupModelChipRules";
import { useGroupRoomLocale } from "./groupRoomI18n";

/**
 * Read-only chip: plain text, no button, no tab stop, no menu. The tooltip
 * (native `title`, also exposed to screen readers) lists "Agent: model".
 */
export function GroupModelChip({
  chip,
  locale: localeProp,
}: {
  chip: GroupModelChipData;
  locale?: string | null | undefined;
}) {
  const locale = useGroupRoomLocale(localeProp);
  return (
    <span
      className={cn(
        MODEL_CHIP_BASE,
        "max-w-[14rem] cursor-default",
        // Same amber as C4's "waiting for you" tone.
        chip.warning ? "border-amber-400/40 text-amber-400" : MODEL_CHIP_TONE,
      )}
      data-kind={chip.kind}
      data-rule={chip.rule}
      data-warning={chip.warning ? "" : undefined}
      data-readonly=""
      data-testid="group-model-chip"
      title={chip.tooltip}
    >
      {chip.warning ? (
        <IconAlertTriangle
          aria-hidden
          className="shrink-0"
          size={ICON.sm}
          stroke={ICON_STROKE.sm}
        />
      ) : (
        <IconCube
          aria-hidden
          className="shrink-0 opacity-70"
          size={ICON.sm}
          stroke={ICON_STROKE.sm}
        />
      )}
      <span className="sr-only">{groupModelChipText("model", locale)}: </span>
      <span className="min-w-0 truncate" data-testid="group-model-chip-label">
        {chip.label}
      </span>
      <span className="sr-only">. {chip.tooltip.replace(/\n/g, "; ")}</span>
    </span>
  );
}
