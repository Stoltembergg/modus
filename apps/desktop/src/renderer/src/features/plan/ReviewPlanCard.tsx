import { IconArrowRight, IconLoader2, IconPencil, IconSparkles, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { HyperPlanRevision, HyperPlanSummary, PlanRef } from "../../../../shared/contracts";
import hpModeGif from "../../assets/hp-mode.gif";
import { ThinkingStates } from "../../components/ui/ThinkingStates";
import { MarkdownMessage } from "../agent/MarkdownMessage";
import { PlanStepList } from "./PlanTool";
import { SpecAcceptanceCriteria } from "./SpecAcceptanceCriteria";

type HyperPlanDraftPreview = { draftId: string; revision: HyperPlanRevision };
type HyperPlanChoice = "revision" | "original";

type HyperPlanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: HyperPlanDraftPreview }
  | { status: "choosing"; preview: HyperPlanDraftPreview; choice: HyperPlanChoice }
  | { status: "review-error"; reason?: string; originalStart?: "pending" | "error" }
  | { status: "choice-error"; preview: HyperPlanDraftPreview; choice: HyperPlanChoice }
  | { status: "start-error"; preview: HyperPlanDraftPreview; choice: HyperPlanChoice };

export function ReviewPlanCard({
  onBuildLocally,
  onContinuePlanning,
  onReviewWithHyperPlan,
  onUseRevisedPlan,
  onKeepPreviousPlan,
  onChoosePlan,
  plan,
  hyperPlanStatus = "idle",
  hyperPlanSummary,
  hyperPlanError,
  hyperPlanState,
}: {
  onBuildLocally: () => void;
  onContinuePlanning: () => void;
  onReviewWithHyperPlan?: () => void;
  onUseRevisedPlan?: () => void;
  onKeepPreviousPlan?: () => void;
  plan: PlanRef;
  hyperPlanStatus?: "idle" | "reviewing" | "applying" | "error" | "completed";
  hyperPlanSummary?: HyperPlanSummary;
  hyperPlanError?: string;
  hyperPlanState?: HyperPlanState;
  onChoosePlan?: (choice: HyperPlanChoice) => void;
}) {
  const [submittedChoice, setSubmittedChoice] = useState<HyperPlanChoice | null>(null);
  useEffect(() => {
    if (
      hyperPlanState?.status === "ready" ||
      hyperPlanState?.status === "choice-error" ||
      hyperPlanState?.status === "start-error" ||
      hyperPlanState?.status === "review-error"
    ) {
      setSubmittedChoice(null);
    }
  }, [hyperPlanState]);

  useEffect(() => {
    if (hyperPlanState && hyperPlanState.status !== "idle") return;
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        onBuildLocally();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onBuildLocally, hyperPlanState]);

  if (hyperPlanState && hyperPlanState.status !== "idle") {
    if (hyperPlanState.status === "loading") return <HyperPlanLoading />;
    return (
      <HyperPlanChoiceCard
        {...(onChoosePlan
          ? {
              onChoice: (choice: HyperPlanChoice) => {
                if (submittedChoice !== null) return;
                setSubmittedChoice(choice);
                onChoosePlan(choice);
              },
              onChoosePlan,
            }
          : {})}
        {...(onReviewWithHyperPlan ? { onReviewWithHyperPlan } : {})}
        state={hyperPlanState}
      />
    );
  }

  const canReviewWithHyperPlan = Boolean(plan.spec && onReviewWithHyperPlan);
  const isReviewing = hyperPlanStatus === "reviewing";
  const isApplying = hyperPlanStatus === "applying";

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
          {isReviewing ? (
            <div
              aria-live="polite"
              className="overflow-hidden rounded-lg border border-accent/20 bg-surface/70 p-2"
              role="status"
            >
              <img
                alt="HyperPlan review in progress"
                className="mx-auto max-h-40 w-auto rounded-md object-contain"
                src={hpModeGif}
              />
              <p className="mt-2 text-center text-xs text-fg-muted">
                Reviewing plan with HyperPlan…
              </p>
            </div>
          ) : null}
          {hyperPlanStatus === "error" ? (
            <section aria-label="Original plan" className="space-y-2" aria-live="polite">
              <p className="text-xs text-danger">{hyperPlanError}</p>
              <div className="rounded-lg border border-hairline bg-surface/50 p-3">
                <h2 className="mb-2 font-medium text-fg text-xs">Original plan</h2>
                <MarkdownMessage className="modus-plan-markdown" content={plan.content} />
              </div>
            </section>
          ) : null}
          {hyperPlanStatus === "completed" && hyperPlanSummary ? (
            <>
              <section aria-label="Revised plan preview" className="space-y-2">
                <div>
                  <h2 className="font-semibold text-fg text-sm">Revised plan preview</h2>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    Nothing changes until you choose to use this revision.
                  </p>
                </div>
                <div className="max-h-60 overflow-y-auto rounded-lg border border-accent/20 bg-surface/60 p-3">
                  <MarkdownMessage
                    className="modus-plan-markdown"
                    content={hyperPlanSummary.revisedContent}
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    className="min-h-10 rounded-lg bg-accent px-3 py-2 font-medium text-accent-foreground text-sm transition-opacity hover:opacity-90"
                    onClick={onUseRevisedPlan}
                    type="button"
                  >
                    Usar plano revisado
                  </button>
                  <button
                    className="min-h-10 rounded-lg border border-hairline px-3 py-2 font-medium text-fg-subtle text-sm transition-colors hover:bg-hover"
                    onClick={onKeepPreviousPlan}
                    type="button"
                  >
                    Manter plano anterior
                  </button>
                </div>
              </section>
              <HyperPlanResult summary={hyperPlanSummary} />
            </>
          ) : null}
          {isApplying ? (
            <p
              aria-live="polite"
              className="flex items-center gap-2 text-xs text-fg-muted"
              role="status"
            >
              <IconLoader2
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
                size={14}
              />
              Applying the revised plan…
            </p>
          ) : null}
        </div>
      ) : null}

      {canReviewWithHyperPlan ? (
        <button
          aria-describedby="hyperplan-description"
          className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-accent/25 px-3 py-2 font-medium text-accent text-sm transition-colors hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60"
          disabled={isReviewing || isApplying}
          onClick={onReviewWithHyperPlan}
          type="button"
        >
          {isReviewing || isApplying ? (
            <IconLoader2
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              size={15}
            />
          ) : (
            <IconSparkles aria-hidden size={15} />
          )}
          {isReviewing || isApplying
            ? isApplying
              ? "Applying revision…"
              : "Reviewing plan…"
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

function HyperPlanLoading() {
  return (
    <div
      aria-label="Reviewing plan"
      aria-live="polite"
      className="flex min-h-[min(58vh,420px)] w-full flex-col items-center justify-center gap-5 overflow-hidden rounded-xl border border-composer-border bg-elevated p-6 shadow-composer-edge"
      role="status"
    >
      <img
        alt=""
        className="max-h-56 w-auto max-w-full object-contain"
        data-testid="hyperplan-gif"
        src={hpModeGif}
      />
      <ThinkingStates className="text-sm text-fg-subtle" label="Thinking through your plan" />
    </div>
  );
}

function HyperPlanChoiceCard({
  onChoice,
  onChoosePlan,
  onReviewWithHyperPlan,
  state,
}: {
  onChoice?: (choice: HyperPlanChoice) => void;
  onChoosePlan?: (choice: HyperPlanChoice) => void;
  onReviewWithHyperPlan?: () => void;
  state: Exclude<HyperPlanState, { status: "idle" } | { status: "loading" }>;
}) {
  if (state.status === "review-error") {
    const originalPending = state.originalStart === "pending";
    const originalFailed = state.originalStart === "error";
    return (
      <section aria-labelledby="hyperplan-review-error" className={choiceCardClass}>
        <div className="mx-auto max-w-md text-center">
          <h2 className="font-semibold text-fg text-base" id="hyperplan-review-error">
            Review unavailable
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            {state.reason?.trim()
              ? state.reason
              : "HyperPlan couldn’t revise this plan. Your original plan is unchanged."}
          </p>
          {!state.reason?.trim() ? null : (
            <p className="mt-1 text-sm leading-relaxed text-fg-subtle">
              Your original plan is unchanged.
            </p>
          )}
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button
              className={secondaryChoiceButtonClass}
              disabled={originalPending || originalFailed}
              onClick={onReviewWithHyperPlan}
              type="button"
            >
              {originalPending ? "Starting original plan…" : "Try review again"}
            </button>
            <button
              className={primaryChoiceButtonClass}
              disabled={!onChoosePlan || originalPending}
              onClick={() => onChoice?.("original")}
              type="button"
            >
              {originalFailed ? "Retry original plan build" : "Build the original plan"}
            </button>
          </div>
        </div>
      </section>
    );
  }

  const preview = state.preview;
  const busy = state.status === "choosing";
  const failedChoice =
    state.status === "choice-error" || state.status === "start-error" ? state.choice : null;

  return (
    <section
      aria-labelledby="hyperplan-revised-title"
      className="rounded-xl border border-composer-border bg-elevated p-3 shadow-composer-edge sm:p-4"
    >
      <div className="scroll-thin max-h-[min(58vh,480px)] overflow-y-auto px-1">
        <div className="mb-4 border-b border-hairline pb-3">
          <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.16em] text-accent">
            Revised plan
          </p>
          <h1 className="font-semibold text-fg text-lg" id="hyperplan-revised-title">
            {preview.revision.title}
          </h1>
          {preview.revision.overview ? (
            <p className="mt-1 text-sm leading-relaxed text-fg-muted">
              {preview.revision.overview}
            </p>
          ) : null}
        </div>
        <MarkdownMessage
          className="modus-plan-markdown text-sm"
          content={preview.revision.content}
        />
        <PlanStepList
          className="mt-4 border-t border-hairline pt-3"
          label="Revised plan tasks"
          steps={preview.revision.todos.map((todo) => ({
            id: todo.id,
            content: todo.content,
            ...(todo.acceptanceCriterionIds?.length
              ? {
                  detail: `Acceptance criteria: ${todo.acceptanceCriterionIds
                    .map(
                      (id) =>
                        preview.revision.spec.acceptanceCriteria.find(
                          (criterion) => criterion.id === id,
                        )?.description ?? id,
                    )
                    .join(" · ")}`,
                }
              : {}),
          }))}
        />
        <RevisionSpec spec={preview.revision.spec} />
      </div>

      {state.status === "choice-error" ? (
        <p aria-live="polite" className="mt-3 text-sm text-danger" role="alert">
          We couldn’t confirm that choice. Retry the same choice to safely continue.
        </p>
      ) : null}
      {state.status === "start-error" ? (
        <p aria-live="polite" className="mt-3 text-sm text-danger" role="alert">
          The build didn’t start. Retry the same choice; the original plan won’t be selected
          automatically.
        </p>
      ) : null}
      {busy ? (
        <p aria-live="polite" className="mt-3 text-center text-sm text-fg-muted" role="status">
          <IconLoader2
            aria-hidden
            className="mr-2 inline animate-spin motion-reduce:animate-none"
            size={15}
          />
          Starting your selected plan…
        </p>
      ) : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <button
          className={primaryChoiceButtonClass}
          disabled={busy || !onChoice || (failedChoice !== null && failedChoice !== "revision")}
          onClick={() => onChoice?.(failedChoice ?? "revision")}
          type="button"
        >
          {failedChoice === "revision"
            ? "Retry revised plan choice"
            : "Accept revised plan and build"}
        </button>
        <button
          className={secondaryChoiceButtonClass}
          disabled={busy || !onChoice || (failedChoice !== null && failedChoice !== "original")}
          onClick={() => onChoice?.(failedChoice ?? "original")}
          type="button"
        >
          {failedChoice === "original" ? "Retry original plan choice" : "Build the original plan"}
        </button>
      </div>
    </section>
  );
}

function RevisionSpec({ spec }: { spec: HyperPlanRevision["spec"] }) {
  const groups = [
    ["Requirements", spec.requirements.map((requirement) => requirement.text)],
    ["Acceptance criteria", spec.acceptanceCriteria.map((criterion) => criterion.description)],
    ["Assumptions", spec.assumptions],
    ["Open questions", spec.openQuestions],
  ] as const;

  if (groups.every(([, items]) => items.length === 0)) return null;

  return (
    <section aria-label="Revised plan Spec" className="mt-4 border-t border-hairline pt-3">
      <h2 className="font-semibold text-fg text-sm">Spec</h2>
      <div className="mt-2 space-y-3">
        {groups.map(([label, items]) =>
          items.length ? (
            <div key={label}>
              <h3 className="mb-1 text-xs font-medium text-fg-muted">{label}</h3>
              <ul className="space-y-1 text-sm leading-relaxed text-fg-subtle">
                {(() => {
                  const occurrences = new Map<string, number>();
                  return items.map((item) => {
                    const occurrence = occurrences.get(item) ?? 0;
                    occurrences.set(item, occurrence + 1);
                    return (
                      <li className="break-words" key={JSON.stringify([label, item, occurrence])}>
                        {item}
                      </li>
                    );
                  });
                })()}
              </ul>
            </div>
          ) : null,
        )}
      </div>
    </section>
  );
}

const choiceCardClass =
  "flex min-h-[min(58vh,420px)] items-center justify-center rounded-xl border border-composer-border bg-elevated p-6 shadow-composer-edge";
const primaryChoiceButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-fg px-4 py-2 text-center font-semibold text-canvas text-sm transition-colors hover:bg-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-55";
const secondaryChoiceButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-hairline bg-surface px-4 py-2 text-center font-medium text-fg text-sm transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-55";

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
