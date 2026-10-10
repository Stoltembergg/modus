import { IconLayoutList } from "@tabler/icons-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FilesChangeEvent, PlanRef } from "../../../../shared/contracts";
import { EmptyState } from "../../components/ui/Panel";
import { MarkdownMessage } from "../agent/MarkdownMessage";
import { SpecAcceptanceCriteria } from "./SpecAcceptanceCriteria";

const WORKSPACE_REVISION_RECHECK_MS = 5_000;

function workspacePathKey(path: string, platform: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
}

/** Read-only Plan document shown in the Inspector. */
export const PlanPanel = memo(function PlanPanel({
  plan,
  sessionCwd,
  active = true,
}: {
  plan: PlanRef | undefined;
  sessionCwd?: string | undefined;
  active?: boolean;
}) {
  const revisionRequestId = useRef(0);
  const revisionRequestInFlight = useRef(false);
  const evidenceRunIds = useMemo(() => {
    const spec = plan?.spec;
    if (!spec) return [];
    const latestRunIds = spec.acceptanceCriteria.flatMap((criterion) => {
      if (!criterion.requiredCheckKinds?.length) return [];
      const runIds = spec.evidence
        .filter((evidence) => evidence.criterionId === criterion.id)
        .flatMap((evidence) => (evidence.runId ? [evidence.runId] : []));
      const latestRunId = runIds.at(-1);
      return latestRunId ? [latestRunId] : [];
    });
    return [...new Set(latestRunIds)].slice(-32);
  }, [plan?.spec]);
  const revisionKey = JSON.stringify({
    active,
    cwd: sessionCwd,
    runIds: evidenceRunIds,
    sessionId: plan?.sessionId,
  });
  const [revisionSnapshot, setRevisionSnapshot] = useState<{
    key: string;
    revisions: ReadonlyMap<string, string | undefined>;
  }>(() => ({ key: "", revisions: new Map() }));
  const currentWorkspaceRevisions =
    revisionSnapshot.key === revisionKey ? revisionSnapshot.revisions : new Map();
  const refreshWorkspaceRevisions = useCallback(
    async (invalidate = true): Promise<void> => {
      if (!invalidate && revisionRequestInFlight.current) return;
      const requestId = ++revisionRequestId.current;
      if (!active || !sessionCwd || !plan?.sessionId || evidenceRunIds.length === 0) {
        setRevisionSnapshot({ key: revisionKey, revisions: new Map() });
        return;
      }
      if (invalidate) setRevisionSnapshot({ key: revisionKey, revisions: new Map() });
      revisionRequestInFlight.current = true;
      try {
        const revisions = await Promise.all(
          evidenceRunIds.map(async (runId) => {
            try {
              const revision = await window.modus.agent.runWorkspaceRevision({
                sessionId: plan.sessionId,
                runId,
              });
              return [runId, revision] as const;
            } catch {
              return [runId, undefined] as const;
            }
          }),
        );
        if (revisionRequestId.current === requestId) {
          setRevisionSnapshot({ key: revisionKey, revisions: new Map(revisions) });
        }
      } finally {
        if (revisionRequestId.current === requestId) revisionRequestInFlight.current = false;
      }
    },
    [active, evidenceRunIds, plan?.sessionId, revisionKey, sessionCwd],
  );

  useEffect(() => {
    let cancelled = false;
    if (!active || !sessionCwd || evidenceRunIds.length === 0) {
      void refreshWorkspaceRevisions();
      return () => {
        cancelled = true;
        revisionRequestId.current += 1;
        revisionRequestInFlight.current = false;
      };
    }

    let watchedRoot: string | undefined;
    let watchReady = false;
    let watcherUnavailable = false;
    const revisionHealthCheck = window.setInterval(() => {
      if (watchReady && !watcherUnavailable) void refreshWorkspaceRevisions(false);
    }, WORKSPACE_REVISION_RECHECK_MS);
    const files = window.modus.files;
    const unsubscribe = files.onChanged((event: FilesChangeEvent) => {
      const currentRoot = watchedRoot ?? sessionCwd;
      const platform = window.modus.app.platform;
      if (workspacePathKey(event.cwd, platform) !== workspacePathKey(currentRoot, platform)) {
        return;
      }
      if (event.watching === false) {
        watcherUnavailable = true;
        watchReady = false;
        revisionRequestId.current += 1;
        setRevisionSnapshot({ key: revisionKey, revisions: new Map() });
        return;
      }
      if (!watchReady) return;
      void refreshWorkspaceRevisions();
    });
    void files
      .watch(sessionCwd)
      .then(async (root: string) => {
        if (cancelled) {
          void files.unwatch(root);
          return;
        }
        watchedRoot = root;
        const watching = await files.isWatching(root).catch(() => false);
        if (cancelled) return;
        if (!watching || watcherUnavailable) {
          setRevisionSnapshot({ key: revisionKey, revisions: new Map() });
          return;
        }
        watchReady = true;
        void refreshWorkspaceRevisions();
      })
      .catch(() => {
        if (!cancelled) {
          setRevisionSnapshot({ key: revisionKey, revisions: new Map() });
        }
      });
    return () => {
      cancelled = true;
      window.clearInterval(revisionHealthCheck);
      revisionRequestId.current += 1;
      revisionRequestInFlight.current = false;
      unsubscribe();
      if (watchedRoot) void files.unwatch(watchedRoot);
    };
  }, [active, evidenceRunIds.length, refreshWorkspaceRevisions, revisionKey, sessionCwd]);

  if (!plan) {
    return (
      <EmptyState
        description="Plan Mode writes a plan here for you to review."
        hint="No plan yet"
        icon={<IconLayoutList size={22} stroke={1.4} />}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-hairline border-b px-[clamp(1.5rem,6%,4rem)]">
        <div className="mx-auto flex w-full max-w-[920px] items-center">
          <span className="min-w-0 flex-1 truncate font-medium text-fg text-sm" title={plan.title}>
            {plan.title}
          </span>
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-[clamp(1.5rem,6%,4rem)] py-7">
        <div className="mx-auto w-full max-w-[760px] space-y-8">
          <h1 className="font-bold text-[2rem] text-fg leading-tight tracking-[-0.03em]">
            {plan.title}
          </h1>
          <MarkdownMessage className="modus-plan-markdown" content={plan.content} />
          {plan.spec ? (
            <SpecAcceptanceCriteria
              currentWorkspaceRevisions={currentWorkspaceRevisions}
              spec={plan.spec}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
});
