import {
  IconArchiveOff,
  IconCheck,
  IconEdit,
  IconExternalLink,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ProjectMemoryCategory,
  ProjectMemoryExternalReference,
  ProjectMemoryRecord,
  ProjectMemoryScope,
  ProjectMemorySnapshot,
  ProjectMemoryStatus,
  ProjectMemoryVerification,
} from "../../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../../shared/contracts";
import { CollapsibleMotion } from "../../../components/ui/CollapsibleMotion";
import { EmptyState } from "../../../components/ui/Panel";
import { ShinyText } from "../../../components/ui/ShinyText";
import { Tooltip } from "../../../components/ui/Tooltip";
import { cn } from "../../../lib/cn";
import { formatClock } from "../../../lib/formatClock";
import { SwitchControl } from "../form-controls";
import {
  ReadOnlyPill,
  SettingsList,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "../settings-layout";

export function groupProjectMemories(
  memories: ProjectMemoryRecord[],
  workspaceId?: string,
): { global: ProjectMemoryRecord[]; project: ProjectMemoryRecord[] } {
  return {
    global: memories.filter((memory) => memory.scope.kind === "global"),
    project:
      workspaceId && workspaceId !== CHATS_WORKSPACE_ID
        ? memories.filter(
            (memory) => memory.scope.kind === "project" && memory.scope.workspaceId === workspaceId,
          )
        : [],
  };
}

export function projectMemoryStatusLabel(status: ProjectMemoryStatus): string {
  switch (status) {
    case "candidate":
      return "Candidate";
    case "active":
      return "Active";
    case "provisional":
      return "Provisional";
    case "needs_review":
      return "Needs review";
    case "superseded":
      return "Superseded";
    case "obsolete":
      return "Obsolete";
  }
}

export function projectMemoryVerifyVisible(status: ProjectMemoryStatus): boolean {
  return status === "provisional" || status === "needs_review";
}

export function projectMemoryVerificationLabel(
  verification: ProjectMemoryRecord["verification"],
): string {
  switch (verification) {
    case "user_explicit":
      return "User explicit";
    case "agent_observed":
      return "Agent observed";
    case "tests_passed":
      return "Tests passed";
    case "parent_verified":
      return "Parent verified";
    case "unverified":
      return "Unverified";
  }
}

export function projectMemoryProvisionalExplanation(): string {
  return "Provisional child/worktree finding — excluded from automatic memory context until parent-checkout verification or integration.";
}

export async function setProjectMemoryScopeEnabled({
  snapshot,
  scope,
  enabled,
  onSnapshot,
  persist,
}: {
  snapshot: ProjectMemorySnapshot;
  scope: ProjectMemoryScope;
  enabled: boolean;
  onSnapshot(snapshot: ProjectMemorySnapshot): void;
  persist(input: { scope: ProjectMemoryScope; enabled: boolean }): Promise<ProjectMemorySnapshot>;
}): Promise<ProjectMemorySnapshot> {
  const optimistic = {
    ...snapshot,
    ...(scope.kind === "global" ? { globalEnabled: enabled } : { projectEnabled: enabled }),
  };
  onSnapshot(optimistic);
  try {
    const updated = await persist({ scope, enabled });
    onSnapshot(updated);
    return updated;
  } catch (error) {
    onSnapshot(snapshot);
    throw error;
  }
}

export async function confirmProjectMemoryRemoval(
  memoryId: string,
  action: "obsolete" | "delete",
  confirm: (action: "obsolete" | "delete") => boolean,
  remove: (memoryId: string, action: "obsolete" | "delete") => Promise<void>,
): Promise<boolean> {
  if (!confirm(action)) return false;
  await remove(memoryId, action);
  return true;
}

function projectMemoryCategoryLabel(category: ProjectMemoryCategory): string {
  return category.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function projectMemorySourceLabel(memory: ProjectMemoryRecord): string {
  const source = memory.evidence[0];
  if (!source) return "No source details";
  if (source.externalReference) return source.externalReference.sourceLabel;
  const detail =
    source.path ?? source.symbol ?? source.branch ?? source.commitSha ?? source.taskRef;
  return detail
    ? `${source.kind.replaceAll("_", " ")} · ${detail}`
    : source.kind.replaceAll("_", " ");
}

export function safeExternalReferenceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function ExternalMemoryReference({ reference }: { reference: ProjectMemoryExternalReference }) {
  const href = safeExternalReferenceUrl(reference.url);
  const label = reference.title?.trim() || reference.url;
  const attribution =
    reference.origin === "agent_supplied_unverified"
      ? `Untrusted · ${reference.sourceLabel} · Needs review`
      : reference.sourceLabel;

  return (
    <div className="flex min-w-0 items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 px-2.5 py-2">
      <IconExternalLink aria-hidden className="mt-0.5 shrink-0 text-warning" size={14} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-2xs text-warning">Untrusted external reference</span>
          <span className="max-w-full truncate text-2xs text-fg-faint">{attribution}</span>
        </div>
        <p className="mt-0.5 text-2xs text-fg-faint">External page content is not verified.</p>
        {href ? (
          <a
            aria-label={`Open external reference: ${label}`}
            className="mt-1 inline-flex max-w-full items-center gap-1 rounded-sm text-xs text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/50"
            href={href}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span className="flex min-w-0 flex-col">
              <span className="block max-w-full truncate">{label}</span>
              {reference.title?.trim() ? (
                <span className="block max-w-full truncate text-2xs text-fg-faint">{href}</span>
              ) : null}
            </span>
            <IconExternalLink aria-hidden className="shrink-0" size={12} />
          </a>
        ) : (
          <span className="mt-1 block max-w-full truncate text-xs text-fg-faint">
            External URL unavailable
          </span>
        )}
      </div>
    </div>
  );
}

export function ProjectMemorySettingsPanel({ workspaceId }: { workspaceId?: string | undefined }) {
  const hasProjectScope = Boolean(workspaceId && workspaceId !== CHATS_WORKSPACE_ID);
  const [snapshot, setSnapshot] = useState<ProjectMemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  const loadSnapshot = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setSnapshot(await window.modus.projectMemory.snapshot(workspaceId ? { workspaceId } : {}));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSnapshot(null);
    setError(undefined);
    void window.modus.projectMemory
      .snapshot(workspaceId ? { workspaceId } : {})
      .then((next: ProjectMemorySnapshot) => {
        if (alive) setSnapshot(next);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  async function toggleScope(scope: ProjectMemoryScope, enabled: boolean): Promise<void> {
    if (!snapshot) return;
    setBusy(scope.kind);
    setError(undefined);
    try {
      await setProjectMemoryScopeEnabled({
        snapshot,
        scope,
        enabled,
        onSnapshot: setSnapshot,
        persist: (input) => window.modus.projectMemory.setEnabled(input),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function verifyMemory(memoryId: string): Promise<void> {
    setBusy(memoryId);
    setError(undefined);
    try {
      setSnapshot(await window.modus.projectMemory.verify({ memoryId }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function removeMemory(memoryId: string, action: "obsolete" | "delete"): Promise<void> {
    setBusy(memoryId);
    setError(undefined);
    try {
      await confirmProjectMemoryRemoval(
        memoryId,
        action,
        (kind) =>
          window.confirm(
            kind === "obsolete"
              ? "Mark this memory obsolete? It will no longer be used as current project knowledge."
              : "Delete this memory and its metadata? This cannot be undone.",
          ),
        async (id, kind) => {
          const next =
            kind === "obsolete"
              ? await window.modus.projectMemory.markObsolete({ memoryId: id })
              : await window.modus.projectMemory.delete({ memoryId: id });
          setSnapshot(next);
        },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const groups = groupProjectMemories(snapshot?.memories ?? [], workspaceId);

  return (
    <>
      <SettingsPageHeader
        description="Keep useful project knowledge visible and under your control."
        title="Project memory"
      />

      {error ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger">
          <span>{error}</span>
          <button
            className="shrink-0 rounded-md px-2 py-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            onClick={() => void loadSnapshot()}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-lg border border-hairline-soft bg-panel px-4 py-5 text-sm text-fg-faint">
          Loading project memory…
        </div>
      ) : snapshot ? (
        <div className="grid gap-5">
          <ProjectMemoryScopeSection
            enabled={snapshot.globalEnabled}
            busy={busy === "global"}
            records={groups.global}
            title="Global"
            description="Available across projects and Inbox."
            onToggle={(enabled) => void toggleScope({ kind: "global" }, enabled)}
            onVerify={(id) => void verifyMemory(id)}
            onRemove={(id, action) => void removeMemory(id, action)}
            busyMemoryId={busy}
          />
          {hasProjectScope ? (
            <ProjectMemoryScopeSection
              enabled={snapshot.projectEnabled}
              busy={busy === "project"}
              records={groups.project}
              title="Current project"
              description="Only available in this project."
              onToggle={(enabled) =>
                void toggleScope({ kind: "project", workspaceId: workspaceId as string }, enabled)
              }
              onVerify={(id) => void verifyMemory(id)}
              onRemove={(id, action) => void removeMemory(id, action)}
              busyMemoryId={busy}
            />
          ) : null}
          {groups.global.length === 0 && groups.project.length === 0 ? (
            <EmptyState
              compact
              description="Verified project knowledge will appear here."
              hint="No saved memories"
            />
          ) : null}
        </div>
      ) : (
        <EmptyState
          compact
          description="Try loading project memory again."
          hint="Memory is unavailable"
        />
      )}
    </>
  );
}

function ProjectMemoryScopeSection({
  title,
  description,
  enabled,
  busy,
  records,
  busyMemoryId,
  onToggle,
  onVerify,
  onRemove,
}: {
  title: string;
  description: string;
  enabled: boolean;
  busy: boolean;
  records: ProjectMemoryRecord[];
  busyMemoryId: string | null;
  onToggle(enabled: boolean): void;
  onVerify(memoryId: string): void;
  onRemove(memoryId: string, action: "obsolete" | "delete"): void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-hairline-soft bg-panel">
      <div className="flex items-center justify-between gap-4 border-hairline-soft border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-normal text-fg">{title}</h3>
          <p className="mt-1 text-xs text-fg-faint">{description}</p>
        </div>
        <SwitchControl
          ariaLabel={`Enable ${title.toLowerCase()} memory`}
          checked={enabled}
          disabled={busy || busyMemoryId !== null}
          onCheckedChange={onToggle}
        />
      </div>
      {records.length === 0 ? (
        <p className="px-4 py-4 text-xs text-fg-faint">No memories in this scope yet.</p>
      ) : (
        <div className="divide-y divide-hairline-soft">
          {records.map((memory) => (
            <ProjectMemoryRow
              key={memory.id}
              memory={memory}
              busy={busyMemoryId === memory.id}
              onVerify={() => onVerify(memory.id)}
              onRemove={(action) => onRemove(memory.id, action)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ProjectMemoryRow({
  memory,
  busy,
  onVerify,
  onRemove,
}: {
  memory: ProjectMemoryRecord;
  busy: boolean;
  onVerify(): void;
  onRemove(action: "obsolete" | "delete"): void;
}) {
  const status = projectMemoryStatusLabel(memory.status);
  const statusStyle =
    memory.status === "provisional" || memory.status === "needs_review"
      ? "border-warning/30 bg-warning/8 text-warning"
      : memory.status === "active"
        ? "border-accent/25 bg-accent/8 text-fg-muted"
        : "border-hairline-soft bg-surface/45 text-fg-faint";
  const lastVerified = memory.lastVerifiedAt
    ? formatClock(Date.parse(memory.lastVerifiedAt))
    : "Not verified";
  const externalReferences = memory.evidence.flatMap((evidence) =>
    evidence.externalReference ? [evidence.externalReference] : [],
  );

  return (
    <article className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-normal text-fg">{memory.title}</h4>
            <span className={cn("rounded border px-1.5 py-0.5 text-2xs", statusStyle)}>
              {status}
            </span>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">
            {memory.claim}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-fg-faint">
            <span>{projectMemoryCategoryLabel(memory.category)}</span>
            <span>Source: {projectMemorySourceLabel(memory)}</span>
            <span>Verification: {projectMemoryVerificationLabel(memory.verification)}</span>
            <span>Last verified: {lastVerified}</span>
          </div>
          {externalReferences.length ? (
            <fieldset className="mt-2 min-w-0 border-0 p-0">
              <legend className="sr-only">External evidence</legend>
              {externalReferences.map((reference) => (
                <ExternalMemoryReference
                  key={`${memory.id}-${reference.url}-${reference.retrievedAt}`}
                  reference={reference}
                />
              ))}
            </fieldset>
          ) : null}
          {projectMemoryVerifyVisible(memory.status) ? (
            <p className="mt-2 text-xs text-warning">
              {memory.status === "provisional"
                ? projectMemoryProvisionalExplanation()
                : "Needs review — verify before relying on it."}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {projectMemoryVerifyVisible(memory.status) ? (
            <button
              className="flex h-7 items-center gap-1.5 rounded-md border border-hairline-soft px-2 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
              disabled={busy}
              onClick={onVerify}
              type="button"
            >
              <IconCheck size={13} stroke={1.8} />
              Verify
            </button>
          ) : null}
          {memory.status !== "obsolete" ? (
            <button
              aria-label={`Mark ${memory.title} obsolete`}
              className="flex size-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
              disabled={busy}
              onClick={() => onRemove("obsolete")}
              title="Mark obsolete"
              type="button"
            >
              <IconArchiveOff size={14} stroke={1.7} />
            </button>
          ) : null}
          <button
            aria-label={`Delete ${memory.title}`}
            className="flex size-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
            disabled={busy}
            onClick={() => onRemove("delete")}
            title="Delete memory"
            type="button"
          >
            <IconTrash size={14} stroke={1.7} />
          </button>
        </div>
      </div>
    </article>
  );
}
