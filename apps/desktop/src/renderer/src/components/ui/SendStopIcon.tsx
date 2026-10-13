/*
 * Composer send/stop icon: the arrow and the stop square share one slot and
 * cross-fade with a slight scale when a run starts or ends. Reduced motion
 * swaps them instantly (no transition).
 */
import { IconArrowUp, IconPlayerStopFilled } from "@tabler/icons-react";
import { cn } from "../../lib/cn";

type SendStopIconProps = {
  busy: boolean;
  className?: string | undefined;
};

const LAYER =
  "col-start-1 row-start-1 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none";

export function SendStopIcon({ busy, className }: SendStopIconProps) {
  return (
    <span aria-hidden="true" className={cn("inline-grid place-items-center", className)}>
      <IconArrowUp
        aria-hidden="true"
        className={cn(LAYER, busy ? "scale-50 opacity-0" : "scale-100 opacity-100")}
        data-icon="send"
        data-visible={busy ? "false" : "true"}
        size="100%"
        stroke={2.2}
      />
      <IconPlayerStopFilled
        aria-hidden="true"
        className={cn(LAYER, "p-[12%]", busy ? "scale-100 opacity-100" : "scale-50 opacity-0")}
        data-icon="stop"
        data-visible={busy ? "true" : "false"}
        size="100%"
      />
    </span>
  );
}
