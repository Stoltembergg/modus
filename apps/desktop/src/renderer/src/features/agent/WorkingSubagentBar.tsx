import { IconLayoutBoard } from "@tabler/icons-react";
import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { tween } from "../../lib/motion";
import { ComposerRail } from "../composer/ComposerRail";

export type WorkingSubagentItem = {
  id: string;
  task: string;
  activityLabel: string;
};

/**
 * Composer rail for in-flight child sessions ("N Working"), same chrome as
 * background terminals. Click opens the local subagent preview sheet.
 */
export function WorkingSubagentBar({
  items,
  onOpen,
}: {
  items: WorkingSubagentItem[];
  onOpen(childSessionId: string): void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) {
    return null;
  }

  const label = `${items.length} Working`;

  return (
    <ComposerRail expanded={expanded} label={label} onExpandedChange={setExpanded}>
      <ul className="flex flex-col">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <m.li
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              initial={{ opacity: 0, y: 4 }}
              key={item.id}
              layout
              transition={tween("base")}
            >
              <button
                className={cn(
                  "group/row flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  "cursor-pointer hover:bg-hover",
                )}
                onClick={() => onOpen(item.id)}
                onMouseDown={(event) => event.preventDefault()}
                title={item.task}
                type="button"
              >
                <IconLayoutBoard className="shrink-0 text-fg-faint" size={14} stroke={1.7} />
                <span className="min-w-0 flex-1 truncate text-sm text-fg-subtle transition-colors group-hover/row:text-fg">
                  {item.task}
                </span>
                <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-xs text-fg-faint transition-colors group-hover/row:text-fg-muted">
                  {item.activityLabel}
                </span>
              </button>
            </m.li>
          ))}
        </AnimatePresence>
      </ul>
    </ComposerRail>
  );
}
