/**
 * Tool Group — ported and adapted from 21st.dev Agent Elements
 * (`lib/agent-ui/components/tools/tool-group.tsx` + `tool-row-base.tsx`),
 * MIT License, Copyright (c) 2026 21st.dev. See THIRD_PARTY_NOTICES.md at the
 * repo root for the full license text.
 *
 * Presentational fold for a run of consecutive tool calls: one header row
 * (shimmering label while streaming, settled summary after), a faint detail
 * (live counts while streaming), a chevron toggle, and the nested rows. While
 * streaming with more than `maskThreshold` rows the list becomes a bounded,
 * bottom-pinned window with a top fade, as upstream does.
 *
 * Modus adaptations: Modus tokens, ShinyText + CollapsibleMotion, the group
 * stays collapsed until the user opens it (no auto-open, no simulated
 * one-by-one reveal: rows appear as real events arrive), nested rows are
 * rendered by the caller (ToolCard etc.) instead of a tool registry.
 */
import { IconChevronRight } from "@tabler/icons-react";
import { m } from "motion/react";
import { Children, type ReactNode, useEffect, useId, useRef } from "react";
import { CollapsibleMotion } from "../../components/ui/CollapsibleMotion";
import { ShinyText } from "../../components/ui/ShinyText";
import { cn } from "../../lib/cn";

export type ToolGroupProps = {
  label: string;
  /** Streaming: a nested call is still running. */
  active?: boolean;
  /** Faint secondary text after the label (e.g. "2 files, 1 search"). */
  detail?: string;
  open: boolean;
  onToggle(): void;
  /** Rows shown before the streaming window starts scrolling (upstream: 4). */
  maskThreshold?: number;
  /** Height of the streaming window in px. */
  streamHeight?: number;
  children: ReactNode;
};

export function ToolGroup({
  label,
  active = false,
  detail,
  open,
  onToggle,
  maskThreshold = 4,
  streamHeight = 220,
  children,
}: ToolGroupProps) {
  const contentId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const count = Children.count(children);
  const windowed = active && open && count > maskThreshold;

  // Keep the newest row in view while the group streams.
  useEffect(() => {
    if (!windowed || count === 0 || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [windowed, count]);

  return (
    <div className="min-w-0" data-tool-group={active ? "streaming" : "settled"}>
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          aria-controls={contentId}
          aria-expanded={open}
          className="group/activity flex min-w-0 max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-sm text-fg-subtle transition-colors hover:text-fg-muted"
          onClick={onToggle}
          type="button"
        >
          {active ? (
            <ShinyText className="min-w-0 truncate">{label}</ShinyText>
          ) : (
            <span className="min-w-0 truncate text-fg-subtle">{label}</span>
          )}
          {detail ? (
            <span
              className="min-w-0 shrink truncate font-normal text-fg-faint"
              data-tool-group-detail
            >
              {detail}
            </span>
          ) : null}
          <m.span
            animate={{ rotate: open ? 90 : 0 }}
            className="flex size-4 shrink-0 items-center justify-center text-fg-faint"
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <IconChevronRight size={12} stroke={1.8} />
          </m.span>
        </button>
      </div>
      <CollapsibleMotion id={contentId} open={open} preset="timeline">
        <div className="relative mt-1.5">
          {windowed ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-linear-to-b from-canvas to-transparent"
              data-tool-group-mask
            />
          ) : null}
          <div
            className={cn("space-y-2.5", windowed && "scroll-thin overflow-y-auto")}
            data-tool-group-list
            ref={listRef}
            style={windowed ? { maxHeight: `${streamHeight}px` } : undefined}
          >
            {children}
          </div>
        </div>
      </CollapsibleMotion>
    </div>
  );
}
