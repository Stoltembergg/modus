/**
 * Plan Tool card + plan step list — ported and adapted from 21st.dev Agent
 * Elements (`lib/agent-ui/components/tools/plan-tool.tsx`, incl. its pending
 * variant), MIT License, Copyright (c) 2026 21st.dev. See
 * THIRD_PARTY_NOTICES.md at the repo root for the full license text.
 *
 * Modus adaptations: Modus tokens and markdown renderer, `useClipFade` for the
 * collapsed preview, a header label instead of a spinner-only pending state
 * ("Writing the plan" shimmer, spinner respects reduced motion), host actions
 * (copy/open) in the header, a structured step list for the plan's tasks, and
 * no Approve button here: approval stays in ReviewPlanCard.
 */
import {
  IconChevronsDown,
  IconChevronsUp,
  IconCircleCheck,
  IconCircleDashed,
  IconFileDescription,
  IconLoader2,
} from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { WorkingText } from "../../components/ui/WorkingText";
import { cn } from "../../lib/cn";
import { useClipFade } from "../../lib/useClipFade";
import { MarkdownMessage } from "../agent/MarkdownMessage";

export type PlanStep = {
  id: string;
  content: string;
  /** Absent ⇒ the row shows its 1-based number instead of a status glyph. */
  status?: "pending" | "in_progress" | "completed";
  /** Secondary line, e.g. linked acceptance criteria. */
  detail?: string;
};

/** Ordered plan steps (tasks) with status glyphs. */
export function PlanStepList({
  steps,
  heading = "Tasks",
  label = heading,
  className,
}: {
  steps: PlanStep[];
  /** Visible heading. */
  heading?: string;
  /** Accessible section name (defaults to the heading). */
  label?: string;
  className?: string;
}) {
  if (steps.length === 0) return null;
  const done = steps.filter((step) => step.status === "completed").length;
  const tracked = steps.some((step) => step.status !== undefined);
  return (
    <section aria-label={label} className={cn("min-w-0", className)} data-plan-steps>
      <h2 className="flex items-baseline gap-2 font-semibold text-fg text-sm">
        {heading}
        <span className="font-normal text-fg-faint text-xs tabular-nums">
          {tracked ? `${done}/${steps.length}` : steps.length}
        </span>
      </h2>
      <ol className="mt-2 space-y-1.5">
        {steps.map((step, index) => (
          <li
            className="flex min-w-0 items-start gap-2.5 rounded-lg border border-hairline bg-surface/50 p-2.5 text-sm"
            data-status={step.status ?? "none"}
            key={step.id}
          >
            <StepMarker index={index} status={step.status} />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "break-words leading-snug",
                  step.status === "completed"
                    ? "text-fg-faint line-through decoration-fg-faint"
                    : step.status === "in_progress"
                      ? "font-medium text-fg"
                      : "text-fg-subtle",
                )}
              >
                {step.content}
              </p>
              {step.detail ? (
                <p className="mt-1 break-words text-xs text-fg-faint">{step.detail}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StepMarker({ index, status }: { index: number; status: PlanStep["status"] }) {
  if (status === "completed") {
    return <IconCircleCheck className="mt-px shrink-0 text-fg-faint" size={15} stroke={1.7} />;
  }
  if (status === "pending" || status === "in_progress") {
    return (
      <IconCircleDashed
        className={cn(
          "mt-px shrink-0",
          status === "in_progress" ? "text-fg-muted" : "text-fg-faint",
        )}
        size={15}
        stroke={1.6}
      />
    );
  }
  return (
    <span className="mt-px flex size-[15px] shrink-0 items-center justify-center rounded-full border border-hairline font-semibold text-[9px] text-fg-faint tabular-nums">
      {index + 1}
    </span>
  );
}

export type PlanToolState = "writing" | "ready" | "failed";

export type PlanToolCardProps = {
  state: PlanToolState;
  title?: string;
  /** Markdown body (or overview) previewed in the card. */
  content?: string;
  /** e.g. "plan.md", shown next to the label. */
  fileName?: string;
  steps?: PlanStep[];
  /** Header actions (copy / open), revealed on hover/focus. */
  actions?: ReactNode;
  defaultExpanded?: boolean;
};

export function PlanToolCard({
  state,
  title,
  content,
  fileName,
  steps = [],
  actions,
  defaultExpanded = false,
}: PlanToolCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const writing = state === "writing";
  const { boxRef, contentRef, clipped } = useClipFade(!expanded);
  const empty = !title && !content;
  const canExpand = !writing && (expanded || clipped || steps.length > 0);

  return (
    <article
      className="group/plan min-w-0 overflow-hidden rounded-xl border border-hairline-soft bg-card"
      data-plan-state={state}
    >
      <header className="flex h-9 items-center gap-2 border-hairline-soft border-b px-4 text-xs">
        {writing ? (
          <IconLoader2
            aria-hidden
            className="shrink-0 animate-spin text-fg-faint motion-reduce:animate-none"
            size={14}
            stroke={1.7}
          />
        ) : (
          <IconFileDescription
            aria-hidden
            className={cn("shrink-0", state === "failed" ? "text-danger" : "text-fg-faint")}
            size={14}
            stroke={1.7}
          />
        )}
        {writing ? (
          <WorkingText>Writing the plan</WorkingText>
        ) : (
          <span className={state === "failed" ? "text-danger" : "text-fg-subtle"}>
            {state === "failed" ? "Plan failed" : "Plan"}
          </span>
        )}
        {fileName ? (
          <span className="min-w-0 truncate font-mono text-fg-faint">{fileName}</span>
        ) : null}
        <span className="flex-1" />
        {actions ? (
          <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/plan:opacity-100 group-focus-within/plan:opacity-100">
            {actions}
          </div>
        ) : null}
        {canExpand ? (
          <button
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse plan" : "Expand plan"}
            className="flex size-6 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg-muted"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            {expanded ? (
              <IconChevronsUp size={13} stroke={1.75} />
            ) : (
              <IconChevronsDown size={13} stroke={1.75} />
            )}
          </button>
        ) : null}
      </header>

      <div className="px-4 pt-3.5 pb-3.5">
        <div
          className={cn(
            !expanded && "max-h-48 overflow-hidden",
            !expanded && clipped && "clip-fade",
          )}
          data-plan-preview={expanded ? "expanded" : "collapsed"}
          ref={boxRef}
        >
          <div ref={contentRef}>
            {title ? (
              <h2 className="mb-4 font-bold text-[1.75rem] text-fg leading-tight tracking-[-0.025em]">
                {title}
              </h2>
            ) : null}
            {content ? (
              <MarkdownMessage
                className="modus-plan-markdown"
                content={content}
                streaming={writing}
              />
            ) : empty ? (
              writing ? (
                <div className="h-20" />
              ) : (
                <p className="text-fg-faint text-xs">No plan content provided.</p>
              )
            ) : null}
          </div>
        </div>

        {expanded && steps.length > 0 ? <PlanStepList className="mt-4" steps={steps} /> : null}

        {canExpand ? (
          <div className="mt-2.5 flex items-center border-hairline-soft border-t pt-2">
            <button
              className="-mx-1.5 h-6 rounded-md px-1.5 text-fg-faint text-xs transition-colors hover:bg-hover hover:text-fg-muted"
              onClick={() => setExpanded((value) => !value)}
              type="button"
            >
              {expanded ? "Hide detailed plan" : "Read detailed plan"}
            </button>
            {!expanded && steps.length > 0 ? (
              <span className="ml-auto text-fg-faint text-xs tabular-nums">
                {steps.length} {steps.length === 1 ? "task" : "tasks"}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
