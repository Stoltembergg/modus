import type {
  PlanAcceptanceCriterion,
  PlanEvidenceRef,
  PlanSpec,
  VerificationEvidenceStatus,
} from "../../../../shared/contracts";
import { cn } from "../../lib/cn";

type CriterionReviewStatus = PlanAcceptanceCriterion["status"] | "unverified";
type RequiredCheckKind = NonNullable<PlanAcceptanceCriterion["requiredCheckKinds"]>[number];

const REQUIRED_CHECK_LABELS: Record<RequiredCheckKind, string> = {
  tests: "Tests",
  typecheck: "Typecheck",
  lint: "Lint",
  build: "Build",
};

const STATUS_LABELS: Record<CriterionReviewStatus, string> = {
  pending: "Pending",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  blocked: "Blocked",
  unverified: "Not verified",
};

const STATUS_CLASSES: Record<CriterionReviewStatus, string> = {
  pending: "border-hairline text-fg-muted",
  passed: "border-success/25 bg-success/8 text-success",
  failed: "border-danger/25 bg-danger/8 text-danger",
  skipped: "border-hairline text-fg-muted",
  blocked: "border-warning/25 bg-warning/8 text-warning",
  unverified: "border-warning/25 bg-warning/8 text-warning",
};

type EvidenceRunGroup = { runId: string; evidence: PlanEvidenceRef[] };

function groupEvidenceByRun(evidence: PlanEvidenceRef[]): {
  latestRunId: string | undefined;
  currentRun: PlanEvidenceRef[];
  earlierRuns: EvidenceRunGroup[];
  unscoped: PlanEvidenceRef[];
} {
  const runIds = [...new Set(evidence.flatMap((item) => (item.runId ? [item.runId] : [])))];
  const latestRunId = runIds.at(-1);
  return {
    latestRunId,
    currentRun: latestRunId ? evidence.filter((item) => item.runId === latestRunId) : [],
    earlierRuns: runIds
      .slice(0, -1)
      .reverse()
      .map((runId) => ({
        runId,
        evidence: evidence.filter((item) => item.runId === runId),
      })),
    unscoped: evidence.filter((item) => !item.runId),
  };
}

function evidenceContradictionStatus(evidence: PlanEvidenceRef[]): CriterionReviewStatus {
  if (evidence.some(({ status }) => status === "failed")) return "failed";
  if (evidence.some(({ status }) => status === "skipped")) return "skipped";
  return "unverified";
}

function hasRequiredCheckEvidence(
  evidence: PlanEvidenceRef[],
  checkKind: RequiredCheckKind,
  latestRunId: string,
): boolean {
  return evidence.some(
    (item) =>
      item.kind === "check" &&
      item.label === REQUIRED_CHECK_LABELS[checkKind] &&
      item.runId === latestRunId &&
      item.status === "passed",
  );
}

export function criterionEvidenceStatus(
  status: PlanAcceptanceCriterion["status"],
  evidence: PlanEvidenceRef[],
  requiredCheckKinds: PlanAcceptanceCriterion["requiredCheckKinds"] = [],
): CriterionReviewStatus {
  if (status !== "passed") return status;
  const latestRunId = evidence.at(-1)?.runId;
  if (!latestRunId || evidence.some((item) => item.runId !== latestRunId)) return "unverified";
  if (evidence.some(({ status: evidenceStatus }) => evidenceStatus !== "passed")) {
    return evidenceContradictionStatus(evidence);
  }
  if (requiredCheckKinds.some((kind) => !hasRequiredCheckEvidence(evidence, kind, latestRunId))) {
    return "unverified";
  }
  return "passed";
}

function evidenceStatusLabel(status: VerificationEvidenceStatus): string {
  if (status === "user_confirmed") return "User confirmed";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function checkLabel(kind: string): string {
  return kind === "typecheck" ? "Typecheck" : kind.charAt(0).toUpperCase() + kind.slice(1);
}

function EvidenceList({ evidence }: { evidence: PlanEvidenceRef[] }) {
  return (
    <ul className="space-y-1.5">
      {evidence.slice(0, 4).map((item) => (
        <li className="min-w-0 text-xs leading-snug" key={item.id}>
          <span className="font-medium text-fg-subtle">{item.label}</span>
          <span className="ml-1 text-fg-faint">({item.kind})</span>
          <span className="ml-1 text-fg-muted">· {evidenceStatusLabel(item.status)}</span>
          {item.runId || item.eventId || item.revision ? (
            <span className="ml-1 break-all text-fg-faint">
              {[
                item.runId ? `Run ${item.runId}` : undefined,
                item.eventId ? `Event ${item.eventId}` : undefined,
                item.revision ? `Revision ${item.revision}` : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : null}
          {item.paths?.length ? (
            <span className="mt-0.5 block break-all text-fg-faint">
              {item.paths.slice(0, 3).join(" · ")}
            </span>
          ) : null}
        </li>
      ))}
      {evidence.length > 4 ? (
        <li className="text-2xs text-fg-faint">+{evidence.length - 4} more references</li>
      ) : null}
    </ul>
  );
}

export function SpecAcceptanceCriteria({ spec }: { spec: PlanSpec }) {
  if (spec.acceptanceCriteria.length === 0) return null;

  const requirements = new Map(
    spec.requirements.map((requirement) => [requirement.id, requirement]),
  );

  return (
    <section aria-label="Acceptance criteria" className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-fg text-sm">Acceptance criteria</h2>
        <span className="text-xs tabular-nums text-fg-faint">{spec.acceptanceCriteria.length}</span>
      </div>
      <ul className="space-y-2">
        {spec.acceptanceCriteria.map((criterion) => {
          const evidence = spec.evidence.filter((item) => item.criterionId === criterion.id);
          const { currentRun, earlierRuns, latestRunId, unscoped } = groupEvidenceByRun(evidence);
          const status = criterionEvidenceStatus(
            criterion.status,
            currentRun,
            criterion.requiredCheckKinds,
          );
          const earlierEvidenceCount =
            earlierRuns.reduce((count, group) => count + group.evidence.length, 0) +
            unscoped.length;
          const requirement = requirements.get(criterion.requirementId);
          return (
            <li
              className="min-w-0 rounded-xl border border-hairline bg-surface/60 p-3"
              key={criterion.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 flex-1 text-sm leading-snug text-fg">
                  {criterion.description}
                </p>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-medium text-2xs",
                    STATUS_CLASSES[status],
                  )}
                >
                  {STATUS_LABELS[status]}
                </span>
              </div>
              {requirement ? (
                <p className="mt-1 text-xs leading-snug text-fg-muted">
                  Requirement: {requirement.text}
                </p>
              ) : null}
              {criterion.requiredCheckKinds?.length ? (
                <ul aria-label="Required checks" className="mt-2 flex flex-wrap gap-1.5">
                  {criterion.requiredCheckKinds.map((kind) => (
                    <li
                      className="rounded-md border border-hairline px-1.5 py-0.5 text-2xs text-fg-muted"
                      key={kind}
                    >
                      {checkLabel(kind)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {currentRun.length ? (
                <div className="mt-2 space-y-1.5 border-hairline border-t pt-2">
                  <p className="text-2xs font-medium text-fg-muted">
                    Latest run{latestRunId ? ` · ${latestRunId}` : ""}
                  </p>
                  <EvidenceList evidence={currentRun} />
                </div>
              ) : null}
              {earlierEvidenceCount ? (
                <details className="mt-2 border-hairline border-t pt-2">
                  <summary className="cursor-pointer text-xs text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus-ring/35">
                    Earlier evidence ({earlierEvidenceCount})
                  </summary>
                  <div className="mt-2 space-y-2">
                    {earlierRuns.map((group) => (
                      <div className="space-y-1" key={group.runId}>
                        <p className="text-2xs font-medium text-fg-faint">Run {group.runId}</p>
                        <EvidenceList evidence={group.evidence} />
                      </div>
                    ))}
                    {unscoped.length ? (
                      <div className="space-y-1">
                        <p className="text-2xs font-medium text-fg-faint">No run linked</p>
                        <EvidenceList evidence={unscoped} />
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}
              {!currentRun.length && status === "unverified" ? (
                <p className="mt-2 text-xs text-fg-faint">No linked evidence for the latest run.</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
