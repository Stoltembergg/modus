import { IconArrowRight, IconLoader2, IconPencil, IconSparkles, IconX } from "@tabler/icons-react";
import { useEffect } from "react";
import type { HyperPlanSummary, PlanRef } from "../../../../shared/contracts";
import { SpecAcceptanceCriteria } from "./SpecAcceptanceCriteria";

export function ReviewPlanCard({
  onBuildLocally,
  onContinuePlanning,
  onReviewWithHyperPlan,
  plan,
  hyperPlanStatus = "idle",
  hyperPlanSummary,
}: {
  onBuildLocally: () => void;
  onContinuePlanning: () => void;
  onReviewWithHyperPlan?: () => void;
  plan: PlanRef;
  hyperPlanStatus?: "idle" | "loading" | "error" | "completed";
  hyperPlanSummary?: HyperPlanSummary;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        onBuildLocally();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onBuildLocally]);

  const canReviewWithHyperPlan = Boolean(plan.spec && onReviewWithHyperPlan);

  return (
    <div className="rounded-xl border border-composer-border bg-elevated p-3 shadow-composer-edge">
      <div className="flex h-7 items-center gap-2 px-1">
        <span className="font-medium text-fg text-sm">Implement this plan?</span>
        <span className="flex-1" />
        <button
          aria-label="Dismiss plan"
          className="flex size-6 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg-subtle"
          onClick={onContinuePlanning}
          type="button"
        >
          <IconX size={15} stroke={1.7} />
        </button>
      </div>

      {plan.spec ? (
        <div className="scroll-thin mt-2 max-h-[min(46vh,360px)] space-y-4 overflow-y-auto px-1 pb-1">
          <SpecAcceptanceCriteria spec={plan.spec} />
          {hyperPlanStatus === "loading" ? (
            <p aria-live="polite" className="flex items-center gap-2 text-xs text-fg-muted">
              <IconLoader2
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
                size={14}
              />
              Reviewing plan…
            </p>
          ) : null}
          {hyperPlanStatus === "error" ? (
            <p aria-live="polite" className="text-xs text-danger">
              Review unavailable. Try again.
            </p>
          ) : null}
          {hyperPlanStatus === "completed" && hyperPlanSummary ? (
            <HyperPlanResult summary={hyperPlanSummary} />
          ) : null}
        </div>
      ) : null}

      {canReviewWithHyperPlan ? (
        <button
          aria-describedby="hyperplan-description"
          className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-accent/25 px-3 py-2 font-medium text-accent text-sm transition-colors hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60"
          disabled={hyperPlanStatus === "loading"}
          onClick={onReviewWithHyperPlan}
          type="button"
        >
          {hyperPlanStatus === "loading" ? (
            <IconLoader2
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              size={15}
            />
          ) : (
            <IconSparkles aria-hidden size={15} />
          )}
          {hyperPlanStatus === "loading"
            ? "Reviewing plan…"
            : hyperPlanStatus === "completed"
              ? "Review again with HyperPlan"
              : hyperPlanStatus === "error"
                ? "Try HyperPlan again"
                : "Review with HyperPlan"}
        </button>
      ) : null}
      {canReviewWithHyperPlan ? (
        <p
          className="mt-1 text-center text-2xs leading-snug text-fg-faint"
          id="hyperplan-description"
        >
          Optional read-only feedback. It does not start a build.
        </p>
      ) : null}

      <button
        className="group mt-2 flex h-11 w-full items-center gap-3 rounded-lg bg-hover px-2.5 text-left transition-colors hover:bg-active"
        onClick={onBuildLocally}
        type="button"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-hairline text-fg-muted text-xs">
          1
        </span>
        <span className="min-w-0 flex-1 font-medium text-fg text-sm">Yes, implement this plan</span>
        <IconArrowRight
          className="shrink-0 text-fg-faint transition-transform group-hover:translate-x-0.5"
          size={17}
          stroke={1.7}
        />
      </button>

      <button
        className="mt-1 flex h-11 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-hover"
        onClick={onContinuePlanning}
        type="button"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-hairline text-fg-faint">
          <IconPencil size={14} stroke={1.65} />
        </span>
        <span className="truncate text-fg-subtle text-sm">No, tell Modus what to change</span>
      </button>
    </div>
  );
}

function criticLabel(critic: string): string {
  const labels: Record<string, string> = {
    architecture: "Architecture",
    risk: "Risk",
    simplicity: "Simplicity",
    failure: "Failure and verification",
  };
  return labels[critic] ?? critic;
}

function HyperPlanResult({ summary }: { summary: HyperPlanSummary }) {
  const sections = [
    ["Agreements", summary.agreements],
    ["Disagreements", summary.disagreements],
    ["Risks", summary.risks],
    ["Open questions", summary.openQuestions],
    ["References", summary.references],
  ] as const;
  const hasSummaryContent = sections.some(([, values]) => values.length > 0);
  const hasFindings = summary.critiques.some(
    (critique) => critique.status === "completed" && critique.findings.length > 0,
  );

  return (
    <section
      aria-label="HyperPlan review results"
      className="space-y-3 border-hairline border-t pt-3"
    >
      <div>
        <h2 className="font-semibold text-fg text-sm">HyperPlan review</h2>
        <p className="mt-0.5 text-xs text-fg-muted">
          Read-only feedback; review the plan before building.
        </p>
      </div>
      <ul className="space-y-2">
        {summary.critiques.map((critique) => (
          <li
            className="rounded-lg border border-hairline bg-surface/50 p-2.5"
            key={critique.critic}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg text-xs">{criticLabel(critique.critic)}</span>
              <span
                className={
                  critique.status === "completed"
                    ? "text-2xs text-fg-muted"
                    : "text-2xs text-warning"
                }
              >
                {critique.status === "completed" ? "Completed" : "Unavailable"}
              </span>
            </div>
            {critique.findings.length ? (
              <ul className="mt-1.5 space-y-1 pl-3 text-xs leading-snug text-fg-subtle">
                {critique.findings.slice(0, 4).map((finding) => (
                  <li className="list-disc break-words" key={`${critique.critic}-${finding}`}>
                    {finding}
                  </li>
                ))}
              </ul>
            ) : null}
            {critique.references.length ? (
              <p className="mt-1.5 break-all text-2xs text-fg-faint">
                {critique.references.slice(0, 3).join(" · ")}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {!hasFindings && !hasSummaryContent ? (
        <p className="text-xs text-fg-muted">
          {summary.critiques.every((critique) => critique.status === "unavailable")
            ? "No critic results are available. This is not an approval."
            : "No findings were reported. This is not an approval."}
        </p>
      ) : null}
      {sections.map(([label, values]) =>
        values.length ? (
          <div key={label}>
            <h3 className="mb-1 text-2xs font-semibold text-fg-muted">{label}</h3>
            <ul className="space-y-1 text-xs leading-snug text-fg-subtle">
              {values.slice(0, 5).map((value) => (
                <li className="break-words" key={`${label}-${value}`}>
                  {value}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </section>
  );
}
