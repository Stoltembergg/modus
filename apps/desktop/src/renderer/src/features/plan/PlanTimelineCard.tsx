import { IconArrowsMaximize } from "@tabler/icons-react";
import type { PlanRef } from "../../../../shared/contracts";
import { CopyButton } from "../../components/ui/CopyButton";
import { type PlanStep, PlanToolCard } from "./PlanTool";

function textArg(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function baseName(path: string | undefined): string | undefined {
  const name = path?.split(/[\\/]/).filter(Boolean).at(-1);
  return name || undefined;
}

/**
 * Transcript card for the plan tool — thin adapter over the ported Plan Tool
 * card (PlanTool.tsx): "Writing the plan" while the call streams, "Plan" /
 * "Plan failed" after; copy + open actions once the plan is ready; the plan's
 * tasks appear in the expanded view.
 */
export function PlanTimelineCard({
  args,
  isComplete,
  isError,
  onOpen,
  plan,
}: {
  args?: unknown;
  isComplete: boolean;
  isError: boolean;
  onOpen?: (plan: PlanRef) => void;
  plan?: PlanRef;
}) {
  const title = plan?.title ?? textArg(args, "title");
  const overview = plan?.overview ?? textArg(args, "overview");
  const content = plan?.content ?? textArg(args, "content");
  const preview = content || overview;
  const ready = isComplete && !isError && plan !== undefined;
  const steps: PlanStep[] = (plan?.todos ?? []).map((todo) => ({
    id: todo.id,
    content: todo.content,
    status: todo.status,
  }));
  const fileName = baseName(plan?.path);

  return (
    <PlanToolCard
      {...(title ? { title } : {})}
      {...(preview ? { content: preview } : {})}
      {...(fileName ? { fileName } : {})}
      {...(ready
        ? {
            actions: (
              <>
                <CopyButton label="Copy plan" text={plan.content} />
                {onOpen ? (
                  <button
                    aria-label="Open plan"
                    className="flex size-6 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg-muted"
                    onClick={() => onOpen(plan)}
                    title="Open plan"
                    type="button"
                  >
                    <IconArrowsMaximize size={13} stroke={1.75} />
                  </button>
                ) : null}
              </>
            ),
          }
        : {})}
      state={isComplete ? (isError ? "failed" : "ready") : "writing"}
      steps={steps}
    />
  );
}
