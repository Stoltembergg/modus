import { useEffect, useRef, useState } from "react";
import type {
  GroupRuntimeEvent,
  GroupTask,
  GroupTaskStatus,
  HarnessTaskCheckKind,
} from "../../../../shared/contracts";
import type {
  GroupIntegrationState,
  GroupTaskDetails as GroupTaskDetailsDto,
  GroupTaskTransitionEvent,
  GroupTaskUserDraft,
} from "../../../../shared/group-work-state";
import { GroupIntegrationDialog } from "./GroupIntegrationDialog";
import { describeGroupError } from "./groupErrors";
import { type GroupTextFn, useGroupText } from "./groupRoomI18n";
import type { MemberLabel } from "./memberLabels";
import { memberLabelText } from "./memberLabels";

type Props = {
  groupId: string;
  taskId: string;
  labels: ReadonlyMap<string, MemberLabel>;
  onClose(): void;
  onOpenSession?(sessionId: string, runId?: string): void;
  onTaskUpdated?(task: GroupTask): void;
};

const CHECK_KINDS: readonly HarnessTaskCheckKind[] = ["tests", "typecheck", "lint", "build"];

function statusLabel(status: GroupTaskStatus, t: GroupTextFn): string {
  switch (status) {
    case "open":
      return t("taskDetails.status.open");
    case "in_progress":
      return t("taskDetails.status.inProgress");
    case "blocked":
      return t("taskDetails.status.blocked");
    case "in_review":
      return t("taskDetails.status.inReview");
    case "done":
      return t("taskDetails.status.done");
    case "cancelled":
      return t("taskDetails.status.cancelled");
  }
}

function displayName(
  sessionId: string | undefined,
  labels: ReadonlyMap<string, MemberLabel>,
  t: GroupTextFn,
): string {
  if (!sessionId) return t("taskDetails.notAssigned");
  const label = labels.get(sessionId);
  return label ? memberLabelText(label) : t("taskDetails.formerMember");
}

function displayStage(stage: GroupTask["stage"], t: GroupTextFn): string {
  switch (stage) {
    case "plan":
      return t("taskDetails.stage.plan");
    case "implement":
      return t("taskDetails.stage.implement");
    case "verify":
      return t("taskDetails.verification");
    case "review":
      return t("taskDetails.stage.review");
    case "deliver":
      return t("taskDetails.stage.deliver");
    default:
      return t("taskDetails.notSet");
  }
}

function outcomeLabel(status: string, t: GroupTextFn): string {
  switch (status) {
    case "passed":
      return t("taskDetails.outcome.passed");
    case "review_approved":
      return t("taskDetails.outcome.reviewApproved");
    case "failed":
      return t("taskDetails.outcome.failed");
    case "skipped":
      return t("taskDetails.outcome.skipped");
    case "stale":
      return t("taskDetails.outcome.stale");
    case "unavailable":
      return t("taskDetails.outcome.unavailable");
    case "user_confirmed":
      return t("taskDetails.outcome.userConfirmed");
    default:
      return t("taskDetails.outcome.missing");
  }
}

function transitionLabel(event: GroupTaskTransitionEvent, t: GroupTextFn): string {
  const action = event.action.replaceAll("_", " ");
  return t("taskDetails.transition", {
    action,
    from: statusLabel(event.fromStatus, t),
    to: statusLabel(event.toStatus, t),
  });
}

function priorityLabel(priority: GroupTaskUserDraft["priority"], t: GroupTextFn): string {
  if (priority === "low") return t("taskDetails.priority.low");
  if (priority === "high") return t("taskDetails.priority.high");
  return t("taskDetails.priority.normal");
}

function kindLabel(kind: GroupTaskUserDraft["kind"], t: GroupTextFn): string {
  switch (kind) {
    case "legacy":
      return t("taskDetails.kind.legacy");
    case "code":
      return t("taskDetails.kind.code");
    case "docs":
      return t("taskDetails.kind.docs");
    case "design":
      return t("taskDetails.kind.design");
    case "review":
      return t("taskDetails.kind.review");
    case "research":
      return t("taskDetails.kind.research");
    case "question":
      return t("taskDetails.kind.question");
  }
}

function checkKindLabel(check: HarnessTaskCheckKind, t: GroupTextFn): string {
  switch (check) {
    case "tests":
      return t("taskDetails.check.tests");
    case "typecheck":
      return t("taskDetails.check.typecheck");
    case "lint":
      return t("taskDetails.check.lint");
    case "build":
      return t("taskDetails.check.build");
  }
}

function editableDraft(task: GroupTask): GroupTaskUserDraft {
  return {
    title: task.title,
    ...(task.description !== undefined ? { description: task.description } : {}),
    kind: task.kind ?? "legacy",
    priority: task.priority ?? "normal",
    dependencyIds: task.dependencyIds ?? [],
    criteria: task.criteria ?? [],
    verificationPolicy: task.verificationPolicy ?? { mode: "none", requireReview: false },
    ...(task.reviewerSessionId ? { reviewerSessionId: task.reviewerSessionId } : {}),
  };
}

/** Task detail for users; source freshness and QA identities are resolved by main. */
export function GroupTaskDetails({
  groupId,
  taskId,
  labels,
  onClose,
  onOpenSession,
  onTaskUpdated,
}: Props) {
  const t = useGroupText();
  const [details, setDetails] = useState<GroupTaskDetailsDto | undefined>();
  const [integrationState, setIntegrationState] = useState<GroupIntegrationState>({});
  const [integrationOpen, setIntegrationOpen] = useState(false);
  const [transitions, setTransitions] = useState<GroupTaskTransitionEvent[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<GroupTaskUserDraft | undefined>();
  const [editVersion, setEditVersion] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const highestEventVersion = useRef(0);
  const highestIntegrationRecordId = useRef<string | undefined>(undefined);
  const highestIntegrationVersion = useRef(0);
  const displayedDetails = useRef<GroupTaskDetailsDto | undefined>(undefined);
  const reload = useRef<(minimumVersion?: number) => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let lastAppliedVersion = 0;
    let integrationRequest = 0;
    highestEventVersion.current = 0;
    highestIntegrationRecordId.current = undefined;
    highestIntegrationVersion.current = 0;
    displayedDetails.current = undefined;
    setDetails(undefined);
    setIntegrationState({});
    setIntegrationOpen(false);
    setTransitions([]);
    setError(undefined);
    setEditing(false);
    setDraft(undefined);
    setEditVersion(undefined);

    function acceptIntegrationState(integration: GroupIntegrationState): void {
      const record = integration.record;
      const version = record?.version ?? 0;
      if (
        record?.id === highestIntegrationRecordId.current &&
        version < highestIntegrationVersion.current
      ) {
        return;
      }
      highestIntegrationRecordId.current = record?.id;
      highestIntegrationVersion.current = version;
      setIntegrationState(integration);
    }

    async function load(minimumVersion = 0): Promise<void> {
      const currentIntegrationRequest = ++integrationRequest;
      try {
        const [next, history, integration] = await Promise.all([
          window.modus.group.getTaskDetails(groupId, taskId),
          window.modus.group.listTaskTransitions(taskId),
          window.modus.group.getIntegrationState(taskId),
        ]);
        if (disposed) return;
        if (currentIntegrationRequest === integrationRequest) {
          acceptIntegrationState(integration);
        }
        const version = next.task.stateVersion ?? 1;
        const currentVersion = displayedDetails.current?.task.stateVersion ?? 0;
        if (version < minimumVersion || version < highestEventVersion.current) return;
        if (displayedDetails.current && version <= Math.max(lastAppliedVersion, currentVersion))
          return;
        lastAppliedVersion = version;
        displayedDetails.current = next;
        setDetails(next);
        setTransitions(history);
        setError(undefined);
      } catch (cause) {
        if (!disposed) setError(describeGroupError(cause, t.locale));
      }
    }

    const request = (minimumVersion = 0) => void load(minimumVersion);
    reload.current = request;
    void load();
    const unsubscribe = window.modus.group.onEvent((event: GroupRuntimeEvent) => {
      if (
        event.type === "group.integration-changed" &&
        event.groupId === groupId &&
        event.taskId === taskId &&
        (event.record.id !== highestIntegrationRecordId.current ||
          event.version > highestIntegrationVersion.current)
      ) {
        const currentIntegrationRequest = ++integrationRequest;
        void window.modus.group
          .getIntegrationState(taskId)
          .then((integration: GroupIntegrationState) => {
            if (disposed || currentIntegrationRequest !== integrationRequest) return;
            if (
              integration.record?.id === event.record.id &&
              integration.record.version < event.version
            ) {
              return;
            }
            acceptIntegrationState(integration);
          })
          .catch(() => undefined);
        return;
      }
      if (
        event.type !== "group.task-changed" ||
        event.groupId !== groupId ||
        event.taskId !== taskId ||
        event.stateVersion <= highestEventVersion.current
      ) {
        return;
      }
      highestEventVersion.current = event.stateVersion;
      void load(event.stateVersion);
    });
    return () => {
      disposed = true;
      integrationRequest += 1;
      unsubscribe();
      if (reload.current === request) reload.current = () => undefined;
    };
  }, [groupId, t.locale, taskId]);

  useEffect(() => {
    if (details && !editing) setDraft(editableDraft(details.task));
  }, [details, editing]);

  async function saveDraft(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!details || !draft) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const updated = await window.modus.group.updateTask(
        details.task.id,
        draft,
        editVersion ?? details.task.stateVersion ?? 1,
      );
      onTaskUpdated?.(updated);
      setEditing(false);
      setEditVersion(undefined);
      reload.current(updated.stateVersion ?? 1);
    } catch (cause) {
      setSaveError(describeGroupError(cause, t.locale));
    } finally {
      setSaving(false);
    }
  }

  if (!details) {
    return (
      <section
        aria-label={t("taskDetails.aria")}
        className="mt-3 rounded-md border border-hairline p-3"
      >
        <button className="float-right text-xs text-fg-faint" onClick={onClose} type="button">
          {t("taskDetails.close")}
        </button>
        {error ? (
          <p className="text-xs text-danger">{error}</p>
        ) : (
          <p className="text-xs text-fg-muted">{t("taskDetails.loading")}</p>
        )}
      </section>
    );
  }

  const { task } = details;
  const hasStoredMerge =
    integrationState.record?.status === "applied" || integrationState.record?.status === "conflict";
  const canReviewIntegration = task.status === "done" || hasStoredMerge;
  return (
    <>
      <section
        aria-label={t("taskDetails.aria")}
        className="mt-3 rounded-md border border-hairline p-3 text-xs"
        data-testid="group-task-details"
      >
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-medium text-fg">{task.title}</h4>
          <button
            aria-label={t("taskDetails.closeAria")}
            className="text-fg-faint hover:text-fg"
            onClick={onClose}
            type="button"
          >
            {t("taskDetails.closeGlyph")}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-fg-muted">
          <span>{statusLabel(task.status, t)}</span>
          <span>
            {t("taskDetails.prioritySuffix", {
              priority: priorityLabel(task.priority ?? "normal", t),
            })}
          </span>
          <span>{displayStage(task.stage, t)}</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-2xs">
          <div>
            <span className="text-fg-faint">{t("taskDetails.owner")}</span>
            <div>{displayName(task.ownerSessionId, labels, t)}</div>
          </div>
          <div>
            <span className="text-fg-faint">{t("taskDetails.reviewer")}</span>
            <div>{displayName(task.reviewerSessionId, labels, t)}</div>
          </div>
        </div>
        {details.blocker ? (
          <div
            className="mt-3 rounded bg-warning/10 px-2 py-1.5 text-warning"
            data-testid="task-blocker"
          >
            {details.blocker.reason}
          </div>
        ) : task.blockedReason ? (
          <div
            className="mt-3 rounded bg-warning/10 px-2 py-1.5 text-warning"
            data-testid="task-blocker"
          >
            {task.blockedReason}
          </div>
        ) : null}
        {details.dependencies.length > 0 ? (
          <div className="mt-3">
            <h5 className="font-medium text-fg-muted">{t("taskDetails.dependencies")}</h5>
            <ul className="mt-1 flex flex-col gap-1">
              {details.dependencies.map((dependency) => (
                <li className="flex justify-between gap-2" key={dependency.id}>
                  <span>{dependency.title}</span>
                  <span className="text-fg-faint">{statusLabel(dependency.status, t)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-3">
          <h5 className="font-medium text-fg-muted">{t("taskDetails.criteriaAndQa")}</h5>
          {details.source.availability !== "available" ? (
            <p className="mt-1 text-warning" data-testid="task-source-availability">
              {details.source.reason ?? t("taskDetails.sourceUnavailable")}
            </p>
          ) : null}
          <ul className="mt-1 flex flex-col gap-2">
            {details.criteria.map((criterion) => (
              <li key={criterion.criterionId}>
                <div className="flex justify-between gap-2">
                  <span>{criterion.description}</span>
                  <span>{outcomeLabel(criterion.status, t)}</span>
                </div>
                {criterion.evidence.map((evidence, index) => (
                  <div
                    className="mt-1 flex items-center justify-between gap-2 text-2xs text-fg-faint"
                    key={`${criterion.criterionId}:${evidence.runId}:${evidence.checkName ?? index}`}
                  >
                    <span>
                      {evidence.checkName ?? t("taskDetails.reviewEvidence")}:{" "}
                      {outcomeLabel(evidence.status, t)}
                    </span>
                    {evidence.reason ? <span>{evidence.reason}</span> : null}
                    {evidence.sessionId ? (
                      <button
                        className="shrink-0 text-accent hover:underline"
                        onClick={() => onOpenSession?.(evidence.sessionId, evidence.runId)}
                        type="button"
                      >
                        {t("taskDetails.openQaSession")}
                      </button>
                    ) : null}
                  </div>
                ))}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-fg-muted">
            {t("taskDetails.review")} {details.review.status.replaceAll("_", " ")}
            {details.review.reviewerSessionId
              ? ` · ${displayName(details.review.reviewerSessionId, labels, t)}`
              : ""}
          </p>
        </div>
        {transitions.length > 0 ? (
          <div className="mt-3">
            <h5 className="font-medium text-fg-muted">{t("taskDetails.history")}</h5>
            <ul className="mt-1 flex flex-col gap-1 text-2xs text-fg-faint">
              {transitions
                .slice(-8)
                .reverse()
                .map((transition) => (
                  <li key={transition.id}>{transitionLabel(transition, t)}</li>
                ))}
            </ul>
          </div>
        ) : null}
        {editing && draft ? (
          <form
            className="mt-3 flex flex-col gap-2 border-t border-hairline pt-3"
            onSubmit={(event) => void saveDraft(event)}
          >
            <label className="flex flex-col gap-1">
              {t("taskDetails.title")}
              <input
                maxLength={200}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                required
                value={draft.title}
              />
            </label>
            <label className="flex flex-col gap-1">
              {t("taskDetails.description")}
              <textarea
                maxLength={4_000}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                value={draft.description ?? ""}
              />
            </label>
            <label className="flex flex-col gap-1">
              {t("taskDetails.kind")}
              <select
                onChange={(event) =>
                  setDraft({ ...draft, kind: event.target.value as GroupTaskUserDraft["kind"] })
                }
                value={draft.kind}
              >
                {(
                  ["legacy", "code", "docs", "design", "review", "research", "question"] as const
                ).map((kind) => (
                  <option key={kind} value={kind}>
                    {kindLabel(kind, t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              {t("taskDetails.priority")}
              <select
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    priority: event.target.value as GroupTaskUserDraft["priority"],
                  })
                }
                value={draft.priority}
              >
                {(["low", "normal", "high"] as const).map((priority) => (
                  <option key={priority} value={priority}>
                    {priorityLabel(priority, t)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="flex flex-col gap-1">
              <legend>{t("taskDetails.dependencies")}</legend>
              {details.dependencyOptions.map((dependency) => (
                <label className="flex items-center gap-2" key={dependency.id}>
                  <input
                    checked={draft.dependencyIds.includes(dependency.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        dependencyIds: event.target.checked
                          ? [...draft.dependencyIds, dependency.id]
                          : draft.dependencyIds.filter((id) => id !== dependency.id),
                      })
                    }
                    type="checkbox"
                  />
                  <span>{dependency.title}</span>
                  <span className="text-fg-faint">{statusLabel(dependency.status, t)}</span>
                </label>
              ))}
              {details.omittedDependencyOptionCount > 0 ? (
                <span className="text-2xs text-fg-faint">
                  {t("taskDetails.omittedDependencies", {
                    count: details.omittedDependencyOptionCount,
                  })}
                </span>
              ) : null}
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend>{t("taskDetails.criteria")}</legend>
              {draft.criteria.map((criterion, index) => (
                <div className="rounded border border-hairline p-2" key={criterion.id}>
                  <label className="flex flex-col gap-1">
                    {t("taskDetails.criterion")}
                    <input
                      maxLength={1_000}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          criteria: draft.criteria.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, description: event.target.value }
                              : item,
                          ),
                        })
                      }
                      required
                      value={criterion.description}
                    />
                  </label>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {CHECK_KINDS.map((check) => (
                      <label className="flex items-center gap-1" key={check}>
                        <input
                          checked={criterion.requiredCheckKinds.includes(check)}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              criteria: draft.criteria.map((item, itemIndex) => {
                                if (itemIndex !== index) return item;
                                const requiredCheckKinds = event.target.checked
                                  ? [...item.requiredCheckKinds, check]
                                  : item.requiredCheckKinds.filter((kind) => kind !== check);
                                return { ...item, requiredCheckKinds };
                              }),
                            })
                          }
                          type="checkbox"
                        />
                        {checkKindLabel(check, t)}
                      </label>
                    ))}
                  </div>
                  <button
                    className="mt-1 text-2xs text-danger"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        criteria: draft.criteria.filter((_, itemIndex) => itemIndex !== index),
                      })
                    }
                    type="button"
                  >
                    {t("taskDetails.removeCriterion")}
                  </button>
                </div>
              ))}
              <button
                className="self-start text-2xs text-accent"
                onClick={() =>
                  setDraft({
                    ...draft,
                    criteria: [
                      ...draft.criteria,
                      {
                        id: `criterion-${crypto.randomUUID()}`,
                        description: t("taskDetails.newCriterion"),
                        requiredCheckKinds: [],
                      },
                    ],
                  })
                }
                type="button"
              >
                {t("taskDetails.addCriterion")}
              </button>
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend>{t("taskDetails.verificationPolicy")}</legend>
              <label className="flex flex-col gap-1">
                {t("taskDetails.mode")}
                <select
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      verificationPolicy: {
                        ...draft.verificationPolicy,
                        mode: event.target
                          .value as GroupTaskUserDraft["verificationPolicy"]["mode"],
                      },
                    })
                  }
                  value={draft.verificationPolicy.mode}
                >
                  <option value="none">{t("taskDetails.noRequiredQa")}</option>
                  <option value="required">{t("taskDetails.requireQa")}</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  checked={draft.verificationPolicy.requireReview}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      verificationPolicy: {
                        ...draft.verificationPolicy,
                        requireReview: event.target.checked,
                      },
                    })
                  }
                  type="checkbox"
                />
                {t("taskDetails.requireReviewerApproval")}
              </label>
            </fieldset>
            <label className="flex flex-col gap-1">
              {t("taskDetails.reviewer")}
              <select
                onChange={(event) => {
                  const { reviewerSessionId: _reviewerSessionId, ...withoutReviewer } = draft;
                  setDraft(
                    event.target.value
                      ? { ...withoutReviewer, reviewerSessionId: event.target.value }
                      : withoutReviewer,
                  );
                }}
                value={draft.reviewerSessionId ?? ""}
              >
                <option value="">{t("taskDetails.noReviewer")}</option>
                {[...labels.entries()].map(([sessionId, label]) => (
                  <option key={sessionId} value={sessionId}>
                    {memberLabelText(label)}
                  </option>
                ))}
              </select>
            </label>
            {saveError ? <p className="text-danger">{saveError}</p> : null}
            <div className="flex justify-end gap-2">
              <button
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setEditVersion(undefined);
                }}
                type="button"
              >
                {t("taskDetails.discard")}
              </button>
              <button disabled={saving} type="submit">
                {saving ? t("taskDetails.saving") : t("taskDetails.saveTask")}
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded border border-hairline px-2 py-1 text-2xs text-fg-muted hover:bg-hover"
              onClick={() => {
                setDraft(editableDraft(task));
                setEditVersion(task.stateVersion ?? 1);
                setSaveError(undefined);
                setEditing(true);
              }}
              type="button"
            >
              {t("taskDetails.editTask")}
            </button>
            {canReviewIntegration ? (
              <button
                className="rounded border border-hairline px-2 py-1 text-2xs text-fg-muted hover:bg-hover"
                onClick={() => setIntegrationOpen(true)}
                type="button"
              >
                {t("taskDetails.reviewIntegration")}
              </button>
            ) : null}
          </div>
        )}
        {error ? <p className="mt-2 text-danger">{error}</p> : null}
      </section>
      {integrationOpen ? (
        <GroupIntegrationDialog
          groupId={groupId}
          onClose={() => setIntegrationOpen(false)}
          taskId={taskId}
        />
      ) : null}
    </>
  );
}
