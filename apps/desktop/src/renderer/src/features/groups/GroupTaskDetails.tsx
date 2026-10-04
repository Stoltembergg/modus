import { useEffect, useRef, useState } from "react";
import type {
  GroupRuntimeEvent,
  GroupTask,
  GroupTaskStatus,
  HarnessTaskCheckKind,
} from "../../../../shared/contracts";
import type {
  GroupTaskDetails as GroupTaskDetailsDto,
  GroupTaskTransitionEvent,
  GroupTaskUserDraft,
} from "../../../../shared/group-work-state";
import { describeGroupError } from "./groupErrors";
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

const STATUS_LABELS: Record<GroupTaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};
const CHECK_KINDS: readonly HarnessTaskCheckKind[] = ["tests", "typecheck", "lint", "build"];

function displayName(
  sessionId: string | undefined,
  labels: ReadonlyMap<string, MemberLabel>,
): string {
  if (!sessionId) return "Not assigned";
  const label = labels.get(sessionId);
  return label ? memberLabelText(label) : "Former member";
}

function displayStage(stage: GroupTask["stage"]): string {
  if (!stage) return "Not set";
  return stage === "verify" ? "Verification" : stage[0]?.toUpperCase() + stage.slice(1);
}

function outcomeLabel(status: string): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "review_approved":
      return "Approved by reviewer";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "stale":
      return "Out of date";
    case "unavailable":
      return "Unavailable";
    case "user_confirmed":
      return "User confirmed (not QA)";
    default:
      return "Missing";
  }
}

function transitionLabel(event: GroupTaskTransitionEvent): string {
  const action = event.action.replaceAll("_", " ");
  return `${action}: ${STATUS_LABELS[event.fromStatus]} → ${STATUS_LABELS[event.toStatus]}`;
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
  const [details, setDetails] = useState<GroupTaskDetailsDto | undefined>();
  const [transitions, setTransitions] = useState<GroupTaskTransitionEvent[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<GroupTaskUserDraft | undefined>();
  const [editVersion, setEditVersion] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const highestEventVersion = useRef(0);
  const displayedDetails = useRef<GroupTaskDetailsDto | undefined>(undefined);
  const reload = useRef<(minimumVersion?: number) => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let lastAppliedVersion = 0;
    highestEventVersion.current = 0;
    displayedDetails.current = undefined;
    setDetails(undefined);
    setTransitions([]);
    setError(undefined);
    setEditing(false);
    setDraft(undefined);
    setEditVersion(undefined);

    async function load(minimumVersion = 0): Promise<void> {
      try {
        const [next, history] = await Promise.all([
          window.modus.group.getTaskDetails(groupId, taskId),
          window.modus.group.listTaskTransitions(taskId),
        ]);
        if (disposed) return;
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
        if (!disposed) setError(describeGroupError(cause));
      }
    }

    const request = (minimumVersion = 0) => void load(minimumVersion);
    reload.current = request;
    void load();
    const unsubscribe = window.modus.group.onEvent((event: GroupRuntimeEvent) => {
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
      unsubscribe();
      if (reload.current === request) reload.current = () => undefined;
    };
  }, [groupId, taskId]);

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
      setSaveError(describeGroupError(cause));
    } finally {
      setSaving(false);
    }
  }

  if (!details) {
    return (
      <section aria-label="Task details" className="mt-3 rounded-md border border-hairline p-3">
        <button className="float-right text-xs text-fg-faint" onClick={onClose} type="button">
          Close
        </button>
        {error ? (
          <p className="text-xs text-danger">{error}</p>
        ) : (
          <p className="text-xs text-fg-muted">Loading task details…</p>
        )}
      </section>
    );
  }

  const { task } = details;
  return (
    <section
      aria-label="Task details"
      className="mt-3 rounded-md border border-hairline p-3 text-xs"
      data-testid="group-task-details"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-medium text-fg">{task.title}</h4>
        <button
          aria-label="Close task details"
          className="text-fg-faint hover:text-fg"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-fg-muted">
        <span>{STATUS_LABELS[task.status]}</span>
        <span>
          {(task.priority ?? "normal")[0]?.toUpperCase()}
          {(task.priority ?? "normal").slice(1)} priority
        </span>
        <span>{displayStage(task.stage)}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-2xs">
        <div>
          <span className="text-fg-faint">Owner</span>
          <div>{displayName(task.ownerSessionId, labels)}</div>
        </div>
        <div>
          <span className="text-fg-faint">Reviewer</span>
          <div>{displayName(task.reviewerSessionId, labels)}</div>
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
          <h5 className="font-medium text-fg-muted">Dependencies</h5>
          <ul className="mt-1 flex flex-col gap-1">
            {details.dependencies.map((dependency) => (
              <li className="flex justify-between gap-2" key={dependency.id}>
                <span>{dependency.title}</span>
                <span className="text-fg-faint">{STATUS_LABELS[dependency.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-3">
        <h5 className="font-medium text-fg-muted">Criteria and QA</h5>
        {details.source.availability !== "available" ? (
          <p className="mt-1 text-warning" data-testid="task-source-availability">
            {details.source.reason ?? "Current source is unavailable."}
          </p>
        ) : null}
        <ul className="mt-1 flex flex-col gap-2">
          {details.criteria.map((criterion) => (
            <li key={criterion.criterionId}>
              <div className="flex justify-between gap-2">
                <span>{criterion.description}</span>
                <span>{outcomeLabel(criterion.status)}</span>
              </div>
              {criterion.evidence.map((evidence, index) => (
                <div
                  className="mt-1 flex items-center justify-between gap-2 text-2xs text-fg-faint"
                  key={`${criterion.criterionId}:${evidence.runId}:${evidence.checkName ?? index}`}
                >
                  <span>
                    {evidence.checkName ?? "Review evidence"}: {outcomeLabel(evidence.status)}
                  </span>
                  {evidence.reason ? <span>{evidence.reason}</span> : null}
                  {evidence.sessionId ? (
                    <button
                      className="shrink-0 text-accent hover:underline"
                      onClick={() => onOpenSession?.(evidence.sessionId, evidence.runId)}
                      type="button"
                    >
                      Open QA session
                    </button>
                  ) : null}
                </div>
              ))}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-2xs text-fg-muted">
          Review: {details.review.status.replaceAll("_", " ")}
          {details.review.reviewerSessionId
            ? ` · ${displayName(details.review.reviewerSessionId, labels)}`
            : ""}
        </p>
      </div>
      {transitions.length > 0 ? (
        <div className="mt-3">
          <h5 className="font-medium text-fg-muted">History</h5>
          <ul className="mt-1 flex flex-col gap-1 text-2xs text-fg-faint">
            {transitions
              .slice(-8)
              .reverse()
              .map((transition) => (
                <li key={transition.id}>{transitionLabel(transition)}</li>
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
            Title
            <input
              maxLength={200}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              required
              value={draft.title}
            />
          </label>
          <label className="flex flex-col gap-1">
            Description
            <textarea
              maxLength={4_000}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              value={draft.description ?? ""}
            />
          </label>
          <label className="flex flex-col gap-1">
            Kind
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
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Priority
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
                  {priority}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend>Dependencies</legend>
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
                <span className="text-fg-faint">{STATUS_LABELS[dependency.status]}</span>
              </label>
            ))}
            {details.omittedDependencyOptionCount > 0 ? (
              <span className="text-2xs text-fg-faint">
                {details.omittedDependencyOptionCount} more tasks are omitted from this list.
              </span>
            ) : null}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend>Criteria</legend>
            {draft.criteria.map((criterion, index) => (
              <div className="rounded border border-hairline p-2" key={criterion.id}>
                <label className="flex flex-col gap-1">
                  Criterion
                  <input
                    maxLength={1_000}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        criteria: draft.criteria.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, description: event.target.value } : item,
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
                      {check}
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
                  Remove criterion
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
                      description: "New criterion",
                      requiredCheckKinds: [],
                    },
                  ],
                })
              }
              type="button"
            >
              Add criterion
            </button>
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend>Verification policy</legend>
            <label className="flex flex-col gap-1">
              Mode
              <select
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    verificationPolicy: {
                      ...draft.verificationPolicy,
                      mode: event.target.value as GroupTaskUserDraft["verificationPolicy"]["mode"],
                    },
                  })
                }
                value={draft.verificationPolicy.mode}
              >
                <option value="none">No required QA</option>
                <option value="required">Require QA</option>
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
              Require reviewer approval
            </label>
          </fieldset>
          <label className="flex flex-col gap-1">
            Reviewer
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
              <option value="">No reviewer</option>
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
              Discard
            </button>
            <button disabled={saving} type="submit">
              {saving ? "Saving…" : "Save task"}
            </button>
          </div>
        </form>
      ) : (
        <button
          className="mt-3 rounded border border-hairline px-2 py-1 text-2xs text-fg-muted hover:bg-hover"
          onClick={() => {
            setDraft(editableDraft(task));
            setEditVersion(task.stateVersion ?? 1);
            setSaveError(undefined);
            setEditing(true);
          }}
          type="button"
        >
          Edit task
        </button>
      )}
      {error ? <p className="mt-2 text-danger">{error}</p> : null}
    </section>
  );
}
