import { randomUUID } from "node:crypto";
import { foldAgentEvents } from "../../shared/agent-events";
import type { AgentEvent, CodeGraphDiscoveryRef, TodoItem } from "../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";
import { getDatabase } from "../db/database";
import { type RunQAEvent, recognizeCheckInvocation } from "./harness/qa-evidence";

type AgentEventRow = {
  id: string;
  payload_json: string;
  created_at: string;
};

type AgentRunPromptRow = {
  id: string;
  user_message_id: string | null;
  prompt: string;
  started_at: string;
};

type AgentEventItem = { id: string; event: AgentEvent; createdAt: string };
const MAX_RUN_TOOL_EVENTS = 500;
const MAX_CODEGRAPH_DISCOVERY_EVENTS = 200;
const MAX_CODEGRAPH_DISCOVERY_REFS = 200;
const MAX_HARNESS_INSIGHT_RUNS = 500;
const MAX_HARNESS_INSIGHT_EVENTS = 5000;

function sqliteBoolean(value: unknown, jsonType: unknown): boolean | undefined {
  if (value === 1 && jsonType === "true") return true;
  if (value === 0 && jsonType === "false") return false;
  return undefined;
}

export type HarnessInsightRunEvidence = {
  runId: string;
  sessionId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
};

export type HarnessInsightEventEvidence = {
  eventId: string;
  sessionId: string;
  type: string;
  createdAt: string;
  runId?: string;
  taskType?: string;
  selectedRole?: string;
  continuationAttempt?: number;
  continuationReason?: string;
  qaRequired?: boolean;
  qaStatus?: string;
  toolName?: string;
  isError?: boolean;
  exitCode?: number;
  aborted?: boolean;
  skipped?: boolean;
  tokenTotal?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  changedPaths?: string[];
  checkpointId?: string;
  childSessionId?: string;
  childStatus?: string;
  subagentType?: string;
};

export type WorkspaceHarnessInsightEvidence = {
  runs: HarnessInsightRunEvidence[];
  events: HarnessInsightEventEvidence[];
};

function toolArgs(event: Extract<AgentEvent, { type: "tool.started" }>): Record<string, unknown> {
  return event.args && typeof event.args === "object" && !Array.isArray(event.args)
    ? (event.args as Record<string, unknown>)
    : {};
}

function safeToolPaths(args: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(args.paths)) return undefined;
  return [...new Set(args.paths.filter((path): path is string => typeof path === "string"))]
    .map((path) => path.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((path) => path.length > 0 && path.length <= 240 && !path.includes("\0"))
    .slice(0, 20);
}

export function recordAgentEvent(event: AgentEvent): void {
  getDatabase()
    .prepare(
      `insert into agent_events (id, session_id, type, payload_json, created_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      event.sessionId,
      event.type,
      JSON.stringify(event),
      new Date().toISOString(),
    );
}

/** Latest persisted to-do list of a session (rehydrates the todo tool store). */
export function getLatestSessionTodos(sessionId: string): TodoItem[] | undefined {
  const row = getDatabase()
    .prepare(
      `select payload_json from agent_events
       where session_id = ? and type = 'todos.updated'
       order by rowid desc
       limit 1`,
    )
    .get(sessionId) as { payload_json: string } | undefined;
  if (!row) {
    return undefined;
  }
  try {
    const event = JSON.parse(row.payload_json) as Extract<AgentEvent, { type: "todos.updated" }>;
    return Array.isArray(event.todos) ? event.todos : undefined;
  } catch {
    return undefined;
  }
}

/** Latest bounded continuation marker for one original/root run. */
export function getLatestTodoContinuationAttempt(sessionId: string, runId: string): number {
  const row = getDatabase()
    .prepare(
      `select json_extract(payload_json, '$.attempt') as attempt from agent_events
       where session_id = ? and type = 'harness.continuation'
         and json_extract(payload_json, '$.runId') = ?
       order by rowid desc
       limit 1`,
    )
    .get(sessionId, runId) as { attempt: number | null } | undefined;
  const attempt = row?.attempt;
  return typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
}

/**
 * Return a bounded, redacted tool-call projection for one exact run. This query
 * never joins or reads agent_runs, so prompt/transcript text cannot enter QA.
 */
export function getRunToolEvidence(sessionId: string, runId: string): RunQAEvent[] {
  const session = getDatabase()
    .prepare("select cwd from agent_sessions where id = ?")
    .get(sessionId) as { cwd?: string } | undefined;
  const rows = getDatabase()
    .prepare(
      `select id, payload_json from agent_events
       where session_id = ? and type in ('tool.started', 'tool.ended')
         and json_extract(payload_json, '$.runId') = ?
       order by rowid desc
       limit ?`,
    )
    .all(sessionId, runId, MAX_RUN_TOOL_EVENTS)
    .reverse() as Array<{ id: string; payload_json: string }>;

  const starts = new Map<
    string,
    {
      toolName: string;
      checkName?: string;
      paths?: string[];
      fullProject?: boolean;
      mutatesSource?: boolean;
    }
  >();
  const evidence: RunQAEvent[] = [];
  for (const row of rows) {
    let event: AgentEvent;
    try {
      event = JSON.parse(row.payload_json) as AgentEvent;
    } catch {
      continue;
    }
    if (event.sessionId !== sessionId || !("runId" in event) || event.runId !== runId) continue;
    if (event.type === "tool.started") {
      const args = toolArgs(event);
      const invocation = recognizeCheckInvocation(
        event.toolName,
        typeof args.command === "string" ? args.command : undefined,
        session?.cwd,
      );
      const checkName = invocation?.checkName;
      const paths = invocation?.paths ?? (checkName ? safeToolPaths(args) : undefined);
      const fullProject = checkName && !paths ? invocation?.fullProject : false;
      const mutatesSource = invocation?.mutatesSource;
      starts.set(event.toolCallId, {
        toolName: event.toolName,
        ...(checkName ? { checkName } : {}),
        ...(paths ? { paths } : {}),
        ...(fullProject ? { fullProject: true } : {}),
        ...(mutatesSource ? { mutatesSource: true } : {}),
      });
      evidence.push({
        type: "tool.started",
        sessionId,
        runId,
        eventId: row.id,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(checkName ? { checkName } : {}),
        ...(paths ? { paths } : {}),
        ...(fullProject ? { fullProject: true } : {}),
        ...(mutatesSource ? { mutatesSource: true } : {}),
      });
      continue;
    }
    if (event.type !== "tool.ended") continue;
    const started = starts.get(event.toolCallId);
    if (!started || (event.toolName && started.toolName !== event.toolName)) continue;
    const exitCode =
      event.exitCode ??
      (started.toolName === "bash" &&
      !event.isError &&
      !event.aborted &&
      !event.skipped &&
      started.checkName
        ? 0
        : undefined);
    evidence.push({
      type: "tool.ended",
      sessionId,
      runId,
      eventId: row.id,
      toolCallId: event.toolCallId,
      toolName: started.toolName,
      ...(started.checkName ? { checkName: started.checkName } : {}),
      ...(started.paths ? { paths: started.paths } : {}),
      ...(started.fullProject ? { fullProject: true } : {}),
      ...(started.mutatesSource ? { mutatesSource: true } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      error: event.isError,
      ...(event.aborted ? { aborted: true } : {}),
      ...(event.skipped ? { skipped: true } : {}),
    });
  }
  return evidence;
}

/** Read a bounded reference-only projection of explicit CodeGraph discoveries. */
export function getSessionCodeGraphDiscoveries(sessionId: string): CodeGraphDiscoveryRef[] {
  const rows = getDatabase()
    .prepare(
      `select payload_json from agent_events
       where session_id = ? and type = 'codegraph.discoveries'
       order by rowid desc
       limit ?`,
    )
    .all(sessionId, MAX_CODEGRAPH_DISCOVERY_EVENTS)
    .reverse() as Array<{ payload_json: string }>;
  const discoveries: CodeGraphDiscoveryRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    let event: unknown;
    try {
      event = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      (event as Record<string, unknown>).type !== "codegraph.discoveries" ||
      (event as Record<string, unknown>).sessionId !== sessionId ||
      typeof (event as Record<string, unknown>).runId !== "string" ||
      !(event as { runId: string }).runId ||
      (event as { runId: string }).runId.length > 128 ||
      !Array.isArray((event as Record<string, unknown>).hits)
    ) {
      continue;
    }
    const runId = (event as { runId: string }).runId;
    for (const value of (event as { hits: unknown[] }).hits.slice(0, 50)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const hit = value as Record<string, unknown>;
      const path = hit.path;
      if (
        typeof path !== "string" ||
        !path ||
        path.length > 512 ||
        path.includes("\0") ||
        path.includes("\\") ||
        path.startsWith("/") ||
        /^[a-zA-Z]:/.test(path) ||
        path.split("/").some((segment) => !segment || segment === ".." || segment === ".")
      ) {
        continue;
      }
      const symbol =
        typeof hit.symbol === "string" && hit.symbol.trim() && hit.symbol.length <= 256
          ? hit.symbol.trim()
          : undefined;
      const kind =
        typeof hit.kind === "string" && hit.kind.trim() && hit.kind.length <= 64
          ? hit.kind.trim()
          : undefined;
      const line =
        typeof hit.line === "number" && Number.isSafeInteger(hit.line) && hit.line > 0
          ? hit.line
          : undefined;
      const reference: CodeGraphDiscoveryRef = {
        runId,
        path,
        ...(symbol ? { symbol } : {}),
        ...(line !== undefined ? { line } : {}),
        ...(kind ? { kind } : {}),
      };
      const key = JSON.stringify(reference);
      if (seen.has(key)) continue;
      seen.add(key);
      discoveries.push(reference);
      if (discoveries.length >= MAX_CODEGRAPH_DISCOVERY_REFS) return discoveries;
    }
  }
  return discoveries;
}

/** Read only bounded, whitelisted event metadata for on-demand local insights. */
export function getWorkspaceHarnessInsightEvidence(
  workspaceId: string,
  since: string,
  until: string,
  limits: { runLimit?: number; eventLimit?: number } = {},
): WorkspaceHarnessInsightEvidence {
  if (workspaceId === CHATS_WORKSPACE_ID) return { runs: [], events: [] };
  const runLimit = Math.max(1, Math.min(limits.runLimit ?? 500, MAX_HARNESS_INSIGHT_RUNS));
  const eventLimit = Math.max(
    1,
    Math.min(limits.eventLimit ?? MAX_HARNESS_INSIGHT_EVENTS, MAX_HARNESS_INSIGHT_EVENTS),
  );
  const db = getDatabase();
  const runs = db
    .prepare(
      `select r.id, r.session_id, r.status, r.started_at, r.completed_at
       from agent_runs r
       join agent_sessions s on s.id = r.session_id
       join workspaces w on w.id = s.workspace_id
       where w.id = ? and r.started_at >= ? and r.started_at <= ?
       order by r.started_at desc, r.rowid desc
       limit ?`,
    )
    .all(workspaceId, since, until, runLimit)
    .reverse() as Array<{
    id: string;
    session_id: string;
    status: string;
    started_at: string;
    completed_at: string | null;
  }>;
  if (runs.length === 0) return { runs: [], events: [] };

  const sessionIds = [...new Set(runs.map((run) => run.session_id))];
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `select e.id as event_id, e.session_id, e.type, e.created_at,
              json_extract(e.payload_json, '$.runId') as run_id,
              json_extract(e.payload_json, '$.taskType') as task_type,
              json_extract(e.payload_json, '$.selectedRole') as selected_role,
              json_extract(e.payload_json, '$.attempt') as continuation_attempt,
              json_extract(e.payload_json, '$.reasonCode') as continuation_reason,
              json_extract(e.payload_json, '$.result.required') as qa_required,
              json_type(e.payload_json, '$.result.required') as qa_required_type,
              json_extract(e.payload_json, '$.result.status') as qa_status,
              json_extract(e.payload_json, '$.toolName') as tool_name,
              json_extract(e.payload_json, '$.isError') as is_error,
              json_type(e.payload_json, '$.isError') as is_error_type,
              json_extract(e.payload_json, '$.exitCode') as exit_code,
              json_extract(e.payload_json, '$.aborted') as aborted,
              json_type(e.payload_json, '$.aborted') as aborted_type,
              json_extract(e.payload_json, '$.skipped') as skipped,
              json_type(e.payload_json, '$.skipped') as skipped_type,
              json_extract(e.payload_json, '$.tokenUsage.totalTokens') as token_total,
              json_extract(e.payload_json, '$.usage.tokens') as context_tokens,
              json_extract(e.payload_json, '$.usage.contextWindow') as context_window,
              json_extract(e.payload_json, '$.usage.percent') as context_percent,
              json_extract(e.payload_json, '$.changes.files') as changed_paths_json,
              json_extract(e.payload_json, '$.checkpointId') as checkpoint_id,
              json_extract(e.payload_json, '$.childSessionId') as child_session_id,
              json_extract(e.payload_json, '$.status') as child_status,
              json_extract(e.payload_json, '$.subagentType') as subagent_type
       from agent_events e
       join agent_sessions s on s.id = e.session_id
       join workspaces w on w.id = s.workspace_id
       where w.id = ? and e.created_at >= ? and e.created_at <= ?
         and e.session_id in (${placeholders})
         and e.type in (
           'run.started', 'run.completed', 'run.failed', 'tool.ended',
           'harness.route', 'harness.qa', 'harness.continuation',
           'checkpoint.restored', 'context.updated', 'subagent.started', 'subagent.updated'
         )
         and json_valid(e.payload_json)
       order by e.rowid desc
       limit ?`,
    )
    .all(workspaceId, since, until, ...sessionIds, eventLimit)
    .reverse() as Array<Record<string, unknown>>;

  const events: HarnessInsightEventEvidence[] = [];
  const runSessionById = new Map(runs.map((run) => [run.id, run.session_id]));
  for (const row of rows) {
    const type = row.type;
    const sessionId = row.session_id;
    const eventId = row.event_id;
    const createdAt = row.created_at;
    if (
      typeof type !== "string" ||
      typeof sessionId !== "string" ||
      typeof eventId !== "string" ||
      typeof createdAt !== "string"
    ) {
      continue;
    }
    const runId = typeof row.run_id === "string" ? row.run_id : undefined;
    if (runId && runSessionById.get(runId) !== sessionId) continue;
    const result: HarnessInsightEventEvidence = { eventId, sessionId, type, createdAt };
    if (runId) result.runId = runId;
    if (typeof row.task_type === "string" && row.task_type.length <= 40) {
      result.taskType = row.task_type;
    }
    if (typeof row.selected_role === "string" && row.selected_role.length <= 40) {
      result.selectedRole = row.selected_role;
    }
    if (
      typeof row.continuation_attempt === "number" &&
      Number.isSafeInteger(row.continuation_attempt) &&
      row.continuation_attempt >= 0
    ) {
      result.continuationAttempt = row.continuation_attempt;
    }
    if (typeof row.continuation_reason === "string" && row.continuation_reason.length <= 64) {
      result.continuationReason = row.continuation_reason;
    }
    const qaRequired = sqliteBoolean(row.qa_required, row.qa_required_type);
    if (qaRequired !== undefined) result.qaRequired = qaRequired;
    if (typeof row.qa_status === "string" && row.qa_status.length <= 32)
      result.qaStatus = row.qa_status;
    if (typeof row.tool_name === "string" && row.tool_name.length <= 128) {
      result.toolName = row.tool_name;
    }
    const isError = sqliteBoolean(row.is_error, row.is_error_type);
    if (isError !== undefined) result.isError = isError;
    if (typeof row.exit_code === "number" && Number.isSafeInteger(row.exit_code)) {
      result.exitCode = row.exit_code;
    }
    const aborted = sqliteBoolean(row.aborted, row.aborted_type);
    if (aborted !== undefined) result.aborted = aborted;
    const skipped = sqliteBoolean(row.skipped, row.skipped_type);
    if (skipped !== undefined) result.skipped = skipped;
    if (typeof row.token_total === "number" && Number.isFinite(row.token_total)) {
      result.tokenTotal = row.token_total;
    }
    if (typeof row.context_tokens === "number" && Number.isFinite(row.context_tokens)) {
      result.contextTokens = row.context_tokens;
    }
    if (typeof row.context_window === "number" && Number.isFinite(row.context_window)) {
      result.contextWindow = row.context_window;
    }
    if (typeof row.context_percent === "number" && Number.isFinite(row.context_percent)) {
      result.contextPercent = row.context_percent;
    }
    if (typeof row.changed_paths_json === "string") {
      try {
        const paths = JSON.parse(row.changed_paths_json) as unknown;
        if (Array.isArray(paths)) {
          result.changedPaths = paths
            .map((file) => {
              if (!file || typeof file !== "object") return undefined;
              const path = (file as Record<string, unknown>).path;
              return typeof path === "string" && path.length <= 512 && !path.includes("\0")
                ? path
                : undefined;
            })
            .filter((path): path is string => path !== undefined)
            .slice(0, 50);
        }
      } catch {
        // Malformed structured path metadata is ignored; no raw event text is read.
      }
    }
    if (typeof row.checkpoint_id === "string" && row.checkpoint_id.length <= 128) {
      result.checkpointId = row.checkpoint_id;
    }
    if (typeof row.child_session_id === "string" && row.child_session_id.length <= 128) {
      result.childSessionId = row.child_session_id;
    }
    if (typeof row.child_status === "string" && row.child_status.length <= 32) {
      result.childStatus = row.child_status;
    }
    if (typeof row.subagent_type === "string" && row.subagent_type.length <= 64) {
      result.subagentType = row.subagent_type;
    }
    events.push(result);
  }
  return {
    runs: runs.map((run) => ({
      runId: run.id,
      sessionId: run.session_id,
      status: run.status,
      startedAt: run.started_at,
      ...(run.completed_at ? { completedAt: run.completed_at } : {}),
    })),
    events,
  };
}

export function listAgentEvents(
  sessionId: string,
): Array<{ id: string; event: AgentEvent; createdAt: string }> {
  const db = getDatabase();
  const rows = db
    .prepare(
      `select id, payload_json, created_at
       from agent_events
       where session_id = ?
       order by created_at asc, rowid asc`,
    )
    .all(sessionId) as AgentEventRow[];
  const events = rows.map((row) => ({
    id: row.id,
    event: JSON.parse(row.payload_json) as AgentEvent,
    createdAt: row.created_at,
  }));
  const runs = db
    .prepare(
      `select id, user_message_id, prompt, started_at
       from agent_runs
       where session_id = ?
       order by started_at asc, rowid asc`,
    )
    .all(sessionId) as AgentRunPromptRow[];

  // Fold streamed deltas into one accumulated item per part before they cross
  // IPC, so opening a long session ships O(parts) rows, not O(deltas) — the
  // renderer parses and builds blocks over the bounded set.
  return foldAgentEvents(backfillUserPromptEvents(sessionId, events, runs));
}

function backfillUserPromptEvents(
  sessionId: string,
  events: AgentEventItem[],
  runs: AgentRunPromptRow[],
): AgentEventItem[] {
  if (runs.length === 0) {
    return events;
  }

  const userMessageTextById = new Map<string, string>();
  for (const { event } of events) {
    if (event.type === "message.started" && event.role === "user") {
      userMessageTextById.set(event.messageId, userMessageTextById.get(event.messageId) ?? "");
      continue;
    }
    if (event.type === "message.delta" && userMessageTextById.has(event.messageId)) {
      userMessageTextById.set(
        event.messageId,
        `${userMessageTextById.get(event.messageId) ?? ""}${event.delta}`,
      );
    }
  }
  const backfilledByRunId = new Map<string, AgentEventItem[]>();

  for (const run of runs) {
    const messageId = run.user_message_id ?? `user:${run.id}`;
    if ((userMessageTextById.get(messageId) ?? "").trim()) {
      continue;
    }
    const createdAt = run.started_at;
    backfilledByRunId.set(run.id, [
      {
        id: `backfill:${run.id}:user:start`,
        event: { type: "message.started", sessionId, messageId, role: "user" },
        createdAt,
      },
      {
        id: `backfill:${run.id}:user:delta`,
        event: { type: "message.delta", sessionId, messageId, delta: run.prompt },
        createdAt,
      },
      {
        id: `backfill:${run.id}:user:completed`,
        event: { type: "message.completed", sessionId, messageId },
        createdAt,
      },
    ]);
  }

  if (backfilledByRunId.size === 0) {
    return events;
  }

  const result: AgentEventItem[] = [];
  for (const item of events) {
    const event = item.event;
    if (event.type === "run.started") {
      const userEvents = backfilledByRunId.get(event.runId);
      if (userEvents) {
        result.push(...userEvents);
        backfilledByRunId.delete(event.runId);
      }
    }
    result.push(item);
  }

  for (const userEvents of backfilledByRunId.values()) {
    result.push(...userEvents);
  }

  return result;
}
