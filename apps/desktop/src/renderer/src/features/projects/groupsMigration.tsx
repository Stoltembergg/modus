import { useEffect, useState } from "react";
import type { GroupsMigrationNotice } from "../../../../shared/contracts";
import { useShellText } from "../../lib/shellText";
import { MarkdownMessage } from "../agent/MarkdownMessage";

/** Old room composer drafts (`modus.group.composerDraft.v1.<groupId>`) die with the rooms. */
export const GROUP_DRAFT_PREFIX = "modus.group.composerDraft.v1.";

export function clearGroupDrafts(storage: Storage): number {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(GROUP_DRAFT_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
  return keys.length;
}

type NoticeApi = {
  notice(): Promise<GroupsMigrationNotice>;
  dismissNotice(): Promise<void>;
};

/**
 * One-time "groups moved to Projects" notice (PR 4). Also clears the old room
 * drafts once the migration has run.
 */
export function GroupsMovedNotice({
  api,
  onOpenSession,
}: {
  api: NoticeApi | undefined;
  onOpenSession(sessionId: string): void;
}) {
  const t = useShellText();
  const [notice, setNotice] = useState<GroupsMigrationNotice | null>(null);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api
      .notice()
      .then((next) => {
        if (!alive) return;
        if (next.migrated) clearGroupDrafts(window.localStorage);
        if (next.show) setNotice(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);
  if (!notice) return null;
  const dismiss = () => {
    setNotice(null);
    void api?.dismissNotice().catch(() => undefined);
  };
  return (
    <div
      className="mx-6 mb-2 rounded-lg border border-hairline-strong bg-panel px-4 py-3 text-sm"
      data-testid="groups-moved-notice"
      role="status"
    >
      <p className="font-medium text-fg">{t("shell.groupsMoved.title")}</p>
      <p className="mt-1 text-fg-muted">
        {t("shell.groupsMoved.body", { names: notice.groups.map((g) => g.title).join(", ") })}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {notice.groups.map((group) => (
          <button
            className="rounded-md px-2 py-1 text-xs text-fg-subtle hover:bg-hover hover:text-fg"
            key={group.sessionId}
            onClick={() => onOpenSession(group.sessionId)}
            type="button"
          >
            {group.title}
          </button>
        ))}
      </div>
      {notice.backup ? (
        <p className="mt-2 break-all text-2xs text-fg-faint">
          {t("shell.groupsMoved.backup", { path: notice.backup })}
        </p>
      ) : null}
      <div className="mt-2 flex justify-end">
        <button
          className="rounded-md px-2.5 py-1 text-xs text-fg hover:bg-hover"
          onClick={dismiss}
          type="button"
        >
          {t("shell.groupsMoved.dismiss")}
        </button>
      </div>
    </div>
  );
}

/** A migrated "(group room)" chat: the room transcript, read-only. Null for any other session. */
export function useMigratedTranscript(
  sessionId: string | undefined,
  readOnly: boolean,
  load: ((sessionId: string) => Promise<string | null>) | undefined,
): string | null {
  const [state, setState] = useState<{ id: string; body: string | null } | null>(null);
  useEffect(() => {
    if (!sessionId || !readOnly || !load) return;
    let alive = true;
    void load(sessionId)
      .then((body) => {
        if (alive) setState({ id: sessionId, body });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sessionId, readOnly, load]);
  return state && state.id === sessionId ? state.body : null;
}

export function MigratedTranscript({ body }: { body: string }) {
  const t = useShellText();
  return (
    <div className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      <div className="mx-auto w-full max-w-3xl" data-testid="migrated-transcript">
        <p className="mb-3 text-2xs uppercase tracking-[0.12em] text-fg-faint">
          {t("shell.groupsMoved.roomHistory")}
        </p>
        <MarkdownMessage content={body} />
      </div>
    </div>
  );
}
