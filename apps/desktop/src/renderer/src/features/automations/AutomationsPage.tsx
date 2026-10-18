import {
  IconArrowLeft,
  IconCheck,
  IconChevronRight,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModusApi } from "../../../../preload/types";
import { localDateTimeToInstant } from "../../../../shared/automation-schedule";
import type {
  AutomationDefinition,
  AutomationExecution,
  AutomationSchedule,
  CreateAutomationRequest,
} from "../../../../shared/automations";
import type { AgentInfo, ModelInfo, WorkspaceInfo } from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import { useShellText } from "../../lib/shellText";

type AutomationApi = ModusApi["automations"];
type Screen = { kind: "list" } | { kind: "detail"; id: string } | { kind: "editor"; id?: string };
type AutomationFormInput = Omit<CreateAutomationRequest, "thinkingVariant"> & {
  thinkingVariant?: string | null;
};

const FIELD_CLASS =
  "w-full rounded-lg border border-hairline bg-surface/60 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-accent/60 focus:bg-surface";
const BUTTON_CLASS =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-45";
const PRIMARY_BUTTON_CLASS =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-accent-contrast transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-45";

export function AutomationsPage({
  api,
  workspaces,
  agents,
  models,
  defaultModelId,
  activeWorkspaceId,
  activeAgentId,
  onOpenConversation,
}: {
  api: AutomationApi;
  workspaces: WorkspaceInfo[];
  agents: AgentInfo[];
  models: ModelInfo[];
  defaultModelId: string;
  activeWorkspaceId?: string | undefined;
  activeAgentId?: string | undefined;
  onOpenConversation(sessionId: string): void;
}) {
  const t = useShellText();
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [definitions, setDefinitions] = useState<AutomationDefinition[]>([]);
  const [history, setHistory] = useState<AutomationExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selected =
    screen.kind === "detail" || screen.kind === "editor"
      ? definitions.find((definition) => definition.id === screen.id)
      : undefined;

  const refreshDefinitions = useCallback(async () => {
    try {
      setDefinitions(await api.list());
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [api]);

  const refreshHistory = useCallback(
    async (id: string) => {
      try {
        setHistory(await api.history(id, 50));
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [api],
  );

  useEffect(() => {
    void refreshDefinitions();
    return api.onEvent((event) => {
      void refreshDefinitions();
      const selectedId = screen.kind === "detail" ? screen.id : undefined;
      if (selectedId && event.type === "execution-changed") void refreshHistory(selectedId);
    });
  }, [api, refreshDefinitions, refreshHistory, screen]);

  useEffect(() => {
    if (screen.kind === "detail") void refreshHistory(screen.id);
    else setHistory([]);
  }, [refreshHistory, screen]);

  const openEditor = (id?: string) => {
    setError(null);
    setScreen(id ? { kind: "editor", id } : { kind: "editor" });
  };

  async function saveDefinition(input: AutomationFormInput, existing?: AutomationDefinition) {
    try {
      setError(null);
      let saved: AutomationDefinition;
      if (existing) {
        saved = await api.update({
          id: existing.id,
          revision: existing.revision,
          patch: input,
        });
      } else {
        const { thinkingVariant, ...definition } = input;
        saved = await api.create({
          ...definition,
          ...(typeof thinkingVariant === "string" ? { thinkingVariant } : {}),
        });
      }
      await refreshDefinitions();
      setScreen({ kind: "detail", id: saved.id });
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    }
  }

  if (screen.kind === "editor") {
    if (screen.id && !selected) {
      return (
        <PageFrame title={t("automation.title")}>
          <p className="text-sm text-fg-muted">{loading ? "…" : t("automation.empty")}</p>
        </PageFrame>
      );
    }
    return (
      <AutomationEditor
        agents={agents}
        activeAgentId={activeAgentId}
        activeWorkspaceId={activeWorkspaceId}
        defaultModelId={defaultModelId}
        error={error}
        initial={selected}
        models={models}
        onCancel={() =>
          setScreen(selected ? { kind: "detail", id: selected.id } : { kind: "list" })
        }
        onSave={(input) => saveDefinition(input, selected)}
        t={t}
        workspaces={workspaces}
      />
    );
  }

  if (screen.kind === "detail" && selected) {
    const activeExecution = history.find((entry) => isActive(entry.status));
    return (
      <PageFrame
        back={() => setScreen({ kind: "list" })}
        title={selected.name}
        backLabel={t("automation.back")}
        t={t}
      >
        {error ? <InlineError>{error}</InlineError> : null}
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={BUTTON_CLASS}
            onClick={() =>
              void api
                .setEnabled(selected.id, !selected.enabled)
                .then(refreshDefinitions)
                .catch((cause) => setError(errorMessage(cause)))
            }
            type="button"
          >
            {selected.enabled ? t("automation.pause") : t("automation.resume")}
          </button>
          {activeExecution ? (
            <button
              className={BUTTON_CLASS}
              onClick={() =>
                void api.stop(activeExecution.id).catch((cause) => setError(errorMessage(cause)))
              }
              type="button"
            >
              <IconPlayerStop size={15} /> {t("automation.stop")}
            </button>
          ) : (
            <button
              className={BUTTON_CLASS}
              onClick={() =>
                void api
                  .runNow(selected.id)
                  .then(refreshDefinitions)
                  .then(() => refreshHistory(selected.id))
                  .catch((cause) => setError(errorMessage(cause)))
              }
              type="button"
            >
              <IconPlayerPlay size={15} /> {t("automation.runNow")}
            </button>
          )}
          <button className={BUTTON_CLASS} onClick={() => openEditor(selected.id)} type="button">
            {t("automation.edit")}
          </button>
          <button
            aria-label={t("automation.delete")}
            className={cn(BUTTON_CLASS, "text-danger hover:text-danger")}
            onClick={() => {
              if (window.confirm(t("automation.deleteConfirm"))) {
                void api
                  .delete(selected.id)
                  .then(() => {
                    setScreen({ kind: "list" });
                    return refreshDefinitions();
                  })
                  .catch((cause) => setError(errorMessage(cause)));
              }
            }}
            type="button"
          >
            <IconTrash size={15} />
          </button>
        </div>
        <section className="mt-5 flex flex-col gap-4">
          <p className="whitespace-pre-wrap text-sm leading-6 text-fg">{selected.instruction}</p>
          <dl className="grid gap-x-8 gap-y-3 border-y border-hairline py-4 text-sm sm:grid-cols-2">
            <DetailField
              label={t("automation.schedule")}
              value={describeSchedule(selected.schedule, selected.timeZone)}
            />
            <DetailField
              label={t("automation.next")}
              value={selected.nextOccurrenceAt ? formatDate(selected.nextOccurrenceAt) : "—"}
            />
            <DetailField
              label={t("automation.project")}
              value={workspaceName(workspaces, selected.workspaceId)}
            />
            <DetailField
              label={t("automation.agent")}
              value={agentName(agents, selected.agentId)}
            />
            <DetailField label={t("automation.model")} value={selected.modelId} />
          </dl>
        </section>
        <section className="mt-6">
          <h3 className="mb-2 text-sm font-medium text-fg">{t("automation.history")}</h3>
          {history.length === 0 ? (
            <p className="py-3 text-sm text-fg-muted">{t("automation.noHistory")}</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {history.map((execution) => (
                <li className="flex min-w-0 items-center gap-3 py-3" key={execution.id}>
                  <span
                    className={cn("size-1.5 shrink-0 rounded-full", statusDot(execution.status))}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg">{statusLabel(execution.status, t)}</p>
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {formatDate(execution.startedAt ?? execution.createdAt)}
                    </p>
                    {execution.error ? (
                      <p className="mt-1 truncate text-xs text-danger">{execution.error}</p>
                    ) : null}
                  </div>
                  {execution.sessionId ? (
                    <button
                      className={BUTTON_CLASS}
                      onClick={() => {
                        if (execution.sessionId) onOpenConversation(execution.sessionId);
                      }}
                      type="button"
                    >
                      {t("automation.openConversation")} <IconChevronRight size={14} />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageFrame>
    );
  }

  return (
    <PageFrame
      actions={
        <button className={PRIMARY_BUTTON_CLASS} onClick={() => openEditor()} type="button">
          <IconPlus size={16} /> {t("automation.create")}
        </button>
      }
      title={t("automation.title")}
      subtitle={t("automation.subtitle")}
    >
      {error ? <InlineError>{error}</InlineError> : null}
      {loading ? (
        <p className="py-4 text-sm text-fg-muted">…</p>
      ) : definitions.length === 0 ? (
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-fg-muted">{t("automation.empty")}</p>
        </div>
      ) : (
        <ul className="divide-y divide-hairline">
          {definitions.map((definition) => (
            <li key={definition.id}>
              <button
                className="flex w-full min-w-0 items-center gap-3 py-4 text-left transition-colors hover:bg-hover/40"
                onClick={() => setScreen({ kind: "detail", id: definition.id })}
                type="button"
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    definition.enabled ? "bg-accent" : "bg-fg-muted/40",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">
                    {definition.name}
                  </span>
                  <span className="mt-1 block truncate text-xs text-fg-muted">
                    {describeSchedule(definition.schedule, definition.timeZone)} ·{" "}
                    {definition.enabled ? t("automation.enabled") : t("automation.paused")}
                  </span>
                </span>
                <IconChevronRight aria-hidden size={16} className="shrink-0 text-fg-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </PageFrame>
  );
}

function PageFrame({
  actions,
  back,
  backLabel,
  children,
  subtitle,
  title,
  t,
}: {
  actions?: React.ReactNode;
  back?: () => void;
  backLabel?: string;
  children: React.ReactNode;
  subtitle?: string;
  title: string;
  t?: ReturnType<typeof useShellText>;
}) {
  return (
    <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-10">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-6 flex min-h-9 items-start justify-between gap-3">
          <div className="min-w-0">
            {back ? (
              <button
                className="mb-2 inline-flex items-center gap-1 text-xs text-fg-muted transition-colors hover:text-fg"
                onClick={back}
                type="button"
              >
                <IconArrowLeft size={14} /> {backLabel ?? t?.("automation.back")}
              </button>
            ) : null}
            <h1 className="text-lg font-medium text-fg">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-fg-muted">{subtitle}</p> : null}
          </div>
          {actions}
        </header>
        {children}
      </div>
    </main>
  );
}

function AutomationEditor({
  agents,
  activeAgentId,
  activeWorkspaceId,
  defaultModelId,
  error,
  initial,
  models,
  onCancel,
  onSave,
  t,
  workspaces,
}: {
  agents: AgentInfo[];
  activeAgentId?: string | undefined;
  activeWorkspaceId?: string | undefined;
  defaultModelId: string;
  error: string | null;
  initial?: AutomationDefinition | undefined;
  models: ModelInfo[];
  onCancel(): void;
  onSave(input: AutomationFormInput): Promise<void>;
  t: ReturnType<typeof useShellText>;
  workspaces: WorkspaceInfo[];
}) {
  const projects = workspaces.filter((workspace) => !workspace.inbox);
  const availableModels = models.filter(
    (model) => model.available && model.enabled && model.configured && !model.locked,
  );
  const firstSchedule = initial?.schedule;
  const [name, setName] = useState(initial?.name ?? "");
  const [instruction, setInstruction] = useState(initial?.instruction ?? "");
  const [workspaceId, setWorkspaceId] = useState(
    initial?.workspaceId ?? activeWorkspaceId ?? projects[0]?.id ?? "",
  );
  const [agentId, setAgentId] = useState(initial?.agentId ?? activeAgentId ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? defaultModelId);
  const [timeZone, setTimeZone] = useState(
    initial?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [kind, setKind] = useState<AutomationSchedule["kind"]>(firstSchedule?.kind ?? "daily");
  const [atLocal, setAtLocal] = useState(
    firstSchedule?.kind === "once"
      ? toLocalInput(firstSchedule.at, initial?.timeZone ?? timeZone)
      : "",
  );
  const [localTime, setLocalTime] = useState(
    firstSchedule && firstSchedule.kind !== "once" ? firstSchedule.localTime : "09:00",
  );
  const [days, setDays] = useState<number[]>(
    firstSchedule?.kind === "weekly" ? firstSchedule.daysOfWeek : [1],
  );
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const selectedModel = useMemo(
    () => availableModels.find((model) => model.id === modelId),
    [availableModels, modelId],
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    const workspace = projects.find((entry) => entry.id === workspaceId);
    if (!workspace) return setLocalError(t("automation.projectRequired"));
    if (!selectedModel) return setLocalError(t("automation.modelRequired"));
    let schedule: AutomationSchedule;
    if (kind === "once") {
      const at = localDateTimeToInstant(atLocal, timeZone);
      if (!at) return setLocalError(t("automation.invalidLocalTime"));
      schedule = { kind: "once", at };
    } else if (kind === "daily") {
      schedule = { kind: "daily", localTime };
    } else {
      if (days.length === 0) return setLocalError(t("automation.daysRequired"));
      schedule = { kind: "weekly", daysOfWeek: days, localTime };
    }
    const nextOccurrence =
      schedule.kind === "once" ? Date.parse(schedule.at) : Number.POSITIVE_INFINITY;
    if (nextOccurrence <= Date.now()) return setLocalError(t("automation.futureRequired"));
    const keepThinking = initial?.modelId === selectedModel.id;
    const changedModel = Boolean(initial && !keepThinking);
    const input: AutomationFormInput = {
      name: name.trim(),
      instruction: instruction.trim(),
      schedule,
      timeZone: timeZone.trim(),
      workspaceId,
      agentId: agentId || null,
      providerId: selectedModel.provider,
      modelId: selectedModel.id,
      thinkingLevel: keepThinking ? initial.thinkingLevel : selectedModel.thinkingLevel,
      ...(keepThinking
        ? initial.thinkingVariant
          ? { thinkingVariant: initial.thinkingVariant }
          : {}
        : selectedModel.thinkingVariant
          ? { thinkingVariant: selectedModel.thinkingVariant }
          : changedModel
            ? { thinkingVariant: null }
            : {}),
    };
    setSaving(true);
    try {
      await onSave(input);
    } catch {
      // The parent exposes the error inline and preserves the draft.
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageFrame title={initial?.name ?? t("automation.create")}>
      {error ? <InlineError>{error}</InlineError> : null}
      {localError ? <InlineError>{localError}</InlineError> : null}
      <form className="flex max-w-2xl flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <Field id="automation-name" label={t("automation.name")}>
          <input
            className={FIELD_CLASS}
            id="automation-name"
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </Field>
        <Field id="automation-instruction" label={t("automation.instruction")}>
          <textarea
            className={cn(FIELD_CLASS, "min-h-28 resize-y leading-5")}
            id="automation-instruction"
            maxLength={65_536}
            onChange={(event) => setInstruction(event.target.value)}
            required
            value={instruction}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="automation-project" label={t("automation.project")}>
            <select
              className={FIELD_CLASS}
              id="automation-project"
              onChange={(event) => setWorkspaceId(event.target.value)}
              required
              value={workspaceId}
            >
              <option value="">{t("automation.selectProject")}</option>
              {projects.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field id="automation-agent" label={t("automation.agent")}>
            <select
              className={FIELD_CLASS}
              id="automation-agent"
              onChange={(event) => setAgentId(event.target.value)}
              value={agentId}
            >
              <option value="">Modus</option>
              {agents
                .filter((agent) => !agent.archivedAt)
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field id="automation-model" label={t("automation.model")}>
            <select
              className={FIELD_CLASS}
              id="automation-model"
              onChange={(event) => setModelId(event.target.value)}
              required
              value={modelId}
            >
              <option value="">{t("automation.selectModel")}</option>
              {models.map((model) => {
                const enabled = availableModels.includes(model);
                return (
                  <option disabled={!enabled} key={model.id} value={model.id}>
                    {model.name}
                    {enabled ? "" : ` · ${t("automation.unavailable")}`}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field id="automation-time-zone" label={t("automation.timeZone")}>
            <input
              className={FIELD_CLASS}
              id="automation-time-zone"
              onChange={(event) => setTimeZone(event.target.value)}
              required
              value={timeZone}
            />
          </Field>
        </div>
        <Field id="automation-schedule" label={t("automation.schedule")}>
          <select
            className={FIELD_CLASS}
            id="automation-schedule"
            onChange={(event) => setKind(event.target.value as AutomationSchedule["kind"])}
            value={kind}
          >
            <option value="once">{t("automation.once")}</option>
            <option value="daily">{t("automation.daily")}</option>
            <option value="weekly">{t("automation.weekly")}</option>
          </select>
        </Field>
        {kind === "once" ? (
          <Field id="automation-at" label={`${t("automation.dateTime")} · ${timeZone}`}>
            <input
              className={FIELD_CLASS}
              id="automation-at"
              onChange={(event) => setAtLocal(event.target.value)}
              required
              type="datetime-local"
              value={atLocal}
            />
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="automation-time" label={t("automation.time")}>
              <input
                className={FIELD_CLASS}
                id="automation-time"
                onChange={(event) => setLocalTime(event.target.value)}
                required
                type="time"
                value={localTime}
              />
            </Field>
            {kind === "weekly" ? (
              <fieldset className="flex min-w-0 flex-col gap-1.5 text-xs text-fg-subtle">
                <legend>{t("automation.days")}</legend>
                <div className="flex flex-wrap gap-x-3 gap-y-2 pt-2">
                  {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                    <label
                      className="inline-flex items-center gap-1.5 text-xs text-fg-subtle"
                      key={day}
                    >
                      <input
                        checked={days.includes(day)}
                        onChange={(event) =>
                          setDays((current) =>
                            event.target.checked
                              ? [...current, day].sort()
                              : current.filter((entry) => entry !== day),
                          )
                        }
                        type="checkbox"
                      />
                      {t(`automation.weekday.${day}` as Parameters<typeof t>[0])}
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </div>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <button className={BUTTON_CLASS} onClick={onCancel} type="button">
            {t("automation.cancel")}
          </button>
          <button className={PRIMARY_BUTTON_CLASS} disabled={saving} type="submit">
            <IconCheck size={15} /> {t("automation.save")}
          </button>
        </div>
      </form>
    </PageFrame>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-xs text-fg-subtle">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-1 truncate text-sm text-fg">{value}</dd>
    </div>
  );
}

function InlineError({ children }: { children: string }) {
  return (
    <p className="mb-3 rounded-md bg-danger/8 px-3 py-2 text-xs text-danger" role="alert">
      {children}
    </p>
  );
}

function workspaceName(workspaces: WorkspaceInfo[], id: string): string {
  return workspaces.find((workspace) => workspace.id === id)?.displayName ?? "—";
}

function agentName(agents: AgentInfo[], id: string | null): string {
  return id ? (agents.find((agent) => agent.id === id)?.name ?? "—") : "Modus";
}

function describeSchedule(schedule: AutomationSchedule, timeZone: string): string {
  if (schedule.kind === "once") return `${formatDate(schedule.at)} · ${timeZone}`;
  if (schedule.kind === "daily") return `${schedule.localTime} · ${timeZone}`;
  return `${schedule.daysOfWeek.map(weekdayShort).join(", ")} · ${schedule.localTime} · ${timeZone}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : value;
}

function toLocalInput(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function weekdayShort(day: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day] ?? "";
}

function statusLabel(
  status: AutomationExecution["status"],
  t: ReturnType<typeof useShellText>,
): string {
  if (
    status === "running" ||
    status === "claimed" ||
    status === "cancelling" ||
    status === "cleanup_failed"
  )
    return t("automation.status.running");
  if (status === "waiting_for_you") return t("automation.status.waiting");
  return t(`automation.status.${status}` as Parameters<typeof t>[0]);
}

function statusDot(status: AutomationExecution["status"]): string {
  if (isActive(status)) return "bg-accent";
  if (status === "failed" || status === "cleanup_failed") return "bg-danger";
  if (status === "completed") return "bg-success";
  return "bg-fg-muted/40";
}

function isActive(status: AutomationExecution["status"]): boolean {
  return ["claimed", "running", "waiting_for_you", "cancelling", "cleanup_failed"].includes(status);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
