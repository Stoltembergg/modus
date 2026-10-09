import { createHash, randomUUID } from "node:crypto";
import { foldAgentEvents } from "../../shared/agent-events";
import type {
  AgentEvent,
  CodeGraphDiscoveryRef,
  HarnessTaskCheckKind,
  HarnessTaskCriterionState,
  HarnessTaskEvidenceRef,
  HarnessTaskState,
  TodoItem,
  VerificationEvidenceStatus,
} from "../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";
import { getDatabase } from "../db/database";
import { getWorkspaceSourceRevision } from "./workspace-source-revision";
import { type RunQAEvent, recognizeCheckInvocation } from "./harness/qa-evidence";
import {
  MAX_TASK_STATE_CRITERIA,
  MAX_TASK_STATE_EVENT_BYTES,
  MAX_TASK_STATE_EVIDENCE,
  MAX_TASK_STATE_EVIDENCE_PER_CRITERION,
  MAX_TASK_STATE_REFS,
  MAX_TASK_STATE_SCAN,
  SAFE_TASK_STATE_ID,
} from "./harness/task-state";

type AgentEventRow = {
  event_cursor: number;
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
// Main-owned fields stored beside durable events; listAgentEvents strips them before IPC.
const QA_CHECK_SNAPSHOT_FIELD = "__qaCheckSnapshot";
const QA_CHECK_CONFIG_STABLE_FIELD = "__qaCheckConfigStable";
const QA_CHECK_SOURCE_STABLE_FIELD = "__qaCheckSourceStable";
const QA_CHECK_SOURCE_REVISION_FIELD = "__qaCheckSourceRevision";
type PersistedQACheckSnapshot = {
  version: 1;
  checkName?: HarnessTaskCheckKind;
  paths?: string[];
  fullProject?: true;
  mutatesSource?: true;
  packageConfigDigest?: string;
  workspaceRevision?: string;
};
const MAX_CODEGRAPH_DISCOVERY_EVENTS = 200;
const MAX_CODEGRAPH_DISCOVERY_REFS = 200;
const MAX_HARNESS_INSIGHT_RUNS = 500;
const MAX_HARNESS_INSIGHT_EVENTS = 5000;
const TASK_STATE_CHECK_KINDS: HarnessTaskCheckKind[] = ["tests", "typecheck", "lint", "build"];
const TASK_STATE_PHASES = [
  "preflight",
  "awaiting_user",
  "planning",
  "executing",
  "verifying",
  "terminal",
] as const;
const TASK_STATE_STATUSES = [
  "not_required",
  "pending",
  "verified",
  "user_confirmed",
  "failed",
  "unknown",
  "blocked",
] as const;
const TASK_STATE_CRITERION_STATUSES = [
  "pending",
  "verified",
  "failed",
  "unknown",
  "blocked",
  "user_confirmed",
] as const;
const TASK_STATE_EVIDENCE_STATUSES: VerificationEvidenceStatus[] = [
  "passed",
  "failed",
  "timed_out",
  "cancelled",
  "skipped",
  "missing",
  "unavailable",
  "user_confirmed",
];
const TASK_STATE_ROLES = [
  "explore",
  "librarian",
  "oracle",
  "reviewer",
  "debugger",
  "ui-ux",
] as const;

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
  timedOut?: boolean;
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

function eventWithoutQACheckSnapshot(event: AgentEvent): Record<string, unknown> {
  const payload = { ...event } as Record<string, unknown>;
  delete payload[QA_CHECK_SNAPSHOT_FIELD];
  delete payload[QA_CHECK_CONFIG_STABLE_FIELD];
  delete payload[QA_CHECK_SOURCE_STABLE_FIELD];
  delete payload[QA_CHECK_SOURCE_REVISION_FIELD];
  return payload;
}

function workspaceRevisionForRun(
  db: ReturnType<typeof getDatabase>,
  sessionId: string,
  runId: string,
): string | undefined {
  const row = db
    .prepare(
      `select s.cwd, c.commit_hash
       from agent_checkpoints c
       join agent_sessions s on s.id = c.session_id
       where c.session_id = ? and c.run_id = ? and c.kind = 'auto'
       order by c.rowid asc limit 1`,
    )
    .get(sessionId, runId) as { cwd?: string; commit_hash?: string } | undefined;
  if (!row?.cwd || !row.commit_hash) return undefined;
  return getWorkspaceSourceRevision(row.cwd, row.commit_hash);
}

/** Content revision of the active run's current Git workspace, when bounded reads are safe. */
export function getRunWorkspaceRevision(sessionId: string, runId: string): string | undefined {
  if (!sessionId || !runId) return undefined;
  try {
    return workspaceRevisionForRun(getDatabase(), sessionId, runId);
  } catch {
    return undefined;
  }
}

/** Capture only typed recognition metadata from the event's owning session at start time. */
function createQACheckSnapshot(
  event: Extract<AgentEvent, { type: "tool.started" }>,
  db: ReturnType<typeof getDatabase>,
): PersistedQACheckSnapshot {
  if (event.toolName !== "bash" && event.toolName !== "terminal_run") {
    return { version: 1 };
  }
  const args = toolArgs(event);
  const session = db.prepare("select cwd from agent_sessions where id = ?").get(event.sessionId) as
    | { cwd?: string }
    | undefined;
  const invocation = recognizeCheckInvocation(
    event.toolName,
    typeof args.command === "string" ? args.command : undefined,
    session?.cwd,
  );
  const checkName = invocation?.checkName;
  const paths = invocation?.paths ?? (checkName ? safeToolPaths(args) : undefined);
  const fullProject = checkName && !paths ? invocation?.fullProject : false;
  const mutatesSource = invocation?.mutatesSource;
  const workspaceRevision =
    checkName && !mutatesSource && event.runId
      ? workspaceRevisionForRun(db, event.sessionId, event.runId)
      : undefined;
  return {
    version: 1,
    ...(checkName ? { checkName } : {}),
    ...(paths ? { paths } : {}),
    ...(fullProject ? { fullProject: true as const } : {}),
    ...(mutatesSource ? { mutatesSource: true as const } : {}),
    ...(invocation?.packageConfigDigest
      ? { packageConfigDigest: invocation.packageConfigDigest }
      : {}),
    ...(workspaceRevision ? { workspaceRevision } : {}),
  };
}

/** Recheck the source content synchronously at the durable tool completion boundary. */
function qaCheckWorkspaceSourceAtEnd(
  event: Extract<AgentEvent, { type: "tool.ended" }>,
  db: ReturnType<typeof getDatabase>,
): { stable: boolean; revision?: string } | undefined {
  if (!event.runId) return undefined;
  const row = db
    .prepare(
      `select payload_json from agent_events
       where session_id = ? and type = 'tool.started'
         and json_extract(payload_json, '$.runId') = ?
         and json_extract(payload_json, '$.toolCallId') = ?
       order by rowid asc limit 1`,
    )
    .get(event.sessionId, event.runId, event.toolCallId) as { payload_json: string } | undefined;
  if (!row) return undefined;
  try {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const started = payload as unknown as Extract<AgentEvent, { type: "tool.started" }>;
    if (
      started.type !== "tool.started" ||
      started.sessionId !== event.sessionId ||
      started.runId !== event.runId ||
      started.toolCallId !== event.toolCallId ||
      (event.toolName !== undefined && started.toolName !== event.toolName)
    ) {
      return undefined;
    }
    const snapshot = readQACheckSnapshot(payload);
    if (snapshot.state !== "valid" || !snapshot.snapshot.checkName) return undefined;
    const revision = workspaceRevisionForRun(db, event.sessionId, event.runId);
    return {
      stable: Boolean(
        snapshot.snapshot.workspaceRevision &&
          revision &&
          revision === snapshot.snapshot.workspaceRevision,
      ),
      ...(revision ? { revision } : {}),
    };
  } catch {
    return { stable: false };
  }
}

/** Revalidate package-script identity against the owning session before storing the end event. */
function packageCheckConfigIsStableAtEnd(
  event: Extract<AgentEvent, { type: "tool.ended" }>,
  db: ReturnType<typeof getDatabase>,
): boolean | undefined {
  if (!event.runId) return undefined;
  const row = db
    .prepare(
      `select payload_json from agent_events
       where session_id = ? and type = 'tool.started'
         and json_extract(payload_json, '$.runId') = ?
         and json_extract(payload_json, '$.toolCallId') = ?
       order by rowid asc limit 1`,
    )
    .get(event.sessionId, event.runId, event.toolCallId) as { payload_json: string } | undefined;
  if (!row) return undefined;
  try {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const started = payload as unknown as Extract<AgentEvent, { type: "tool.started" }>;
    if (
      started.type !== "tool.started" ||
      started.sessionId !== event.sessionId ||
      started.runId !== event.runId ||
      started.toolCallId !== event.toolCallId ||
      (event.toolName !== undefined && started.toolName !== event.toolName)
    ) {
      return undefined;
    }
    const snapshot = readQACheckSnapshot(payload);
    if (snapshot.state !== "valid" || !snapshot.snapshot.packageConfigDigest) return undefined;
    const args = toolArgs(started);
    const session = db
      .prepare("select cwd from agent_sessions where id = ?")
      .get(event.sessionId) as { cwd?: string } | undefined;
    const invocation = recognizeCheckInvocation(
      started.toolName,
      typeof args.command === "string" ? args.command : undefined,
      session?.cwd,
    );
    return (
      invocation?.checkName === snapshot.snapshot.checkName &&
      invocation?.packageConfigDigest === snapshot.snapshot.packageConfigDigest
    );
  } catch {
    return false;
  }
}

function serializeAgentEvent(event: AgentEvent, db: ReturnType<typeof getDatabase>): string {
  const payload = eventWithoutQACheckSnapshot(event);
  if (event.type === "tool.started") {
    payload[QA_CHECK_SNAPSHOT_FIELD] = createQACheckSnapshot(event, db);
  } else if (event.type === "tool.ended") {
    const stable = packageCheckConfigIsStableAtEnd(event, db);
    if (stable !== undefined) payload[QA_CHECK_CONFIG_STABLE_FIELD] = stable;
    const source = qaCheckWorkspaceSourceAtEnd(event, db);
    if (source) {
      payload[QA_CHECK_SOURCE_STABLE_FIELD] = source.stable;
      if (source.revision) payload[QA_CHECK_SOURCE_REVISION_FIELD] = source.revision;
    }
  }
  return JSON.stringify(payload);
}

function validQACheckSnapshot(value: unknown): PersistedQACheckSnapshot | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "checkName",
      "paths",
      "fullProject",
      "mutatesSource",
      "packageConfigDigest",
      "workspaceRevision",
    ]) ||
    value.version !== 1 ||
    (value.checkName !== undefined &&
      (typeof value.checkName !== "string" ||
        !TASK_STATE_CHECK_KINDS.includes(value.checkName as HarnessTaskCheckKind))) ||
    (value.paths !== undefined &&
      (!Array.isArray(value.paths) ||
        value.paths.length > 20 ||
        !value.paths.every(
          (path) =>
            typeof path === "string" &&
            path.length > 0 &&
            path.length <= 240 &&
            !path.includes("\0") &&
            path === path.trim(),
        ))) ||
    (value.fullProject !== undefined && value.fullProject !== true) ||
    (value.mutatesSource !== undefined && value.mutatesSource !== true) ||
    (value.packageConfigDigest !== undefined &&
      (typeof value.packageConfigDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.packageConfigDigest))) ||
    (value.workspaceRevision !== undefined &&
      (typeof value.workspaceRevision !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.workspaceRevision))) ||
    (value.checkName === undefined &&
      (value.paths !== undefined ||
        value.fullProject !== undefined ||
        value.mutatesSource !== undefined ||
        value.packageConfigDigest !== undefined ||
        value.workspaceRevision !== undefined))
  ) {
    return undefined;
  }
  return {
    version: 1,
    ...(value.checkName ? { checkName: value.checkName as HarnessTaskCheckKind } : {}),
    ...(value.paths ? { paths: value.paths as string[] } : {}),
    ...(value.fullProject ? { fullProject: true as const } : {}),
    ...(value.mutatesSource ? { mutatesSource: true as const } : {}),
    ...(value.packageConfigDigest
      ? { packageConfigDigest: value.packageConfigDigest as string }
      : {}),
    ...(value.workspaceRevision
      ? { workspaceRevision: value.workspaceRevision as string }
      : {}),
  };
}

function readQACheckSnapshot(
  payload: Record<string, unknown>,
):
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "valid"; snapshot: PersistedQACheckSnapshot } {
  if (!Object.hasOwn(payload, QA_CHECK_SNAPSHOT_FIELD)) return { state: "missing" };
  const snapshot = validQACheckSnapshot(payload[QA_CHECK_SNAPSHOT_FIELD]);
  return snapshot ? { state: "valid", snapshot } : { state: "invalid" };
}

/** One tool call has one authoritative start and end, regardless of delivery keys. */
function existingToolLifecycleEvent(
  event: AgentEvent,
  db: ReturnType<typeof getDatabase>,
): { rowid: number; payload_json: string } | undefined {
  if ((event.type !== "tool.started" && event.type !== "tool.ended") || !event.runId) {
    return undefined;
  }
  const row = db
    .prepare(
      `select rowid, payload_json from agent_events
     where session_id = ? and type = ?
       and json_extract(payload_json, '$.runId') = ?
       and json_extract(payload_json, '$.toolCallId') = ?
     order by rowid asc limit 1`,
    )
    .get(event.sessionId, event.type, event.runId, event.toolCallId) as
    | { rowid: number; payload_json: string }
    | undefined;
  if (
    row &&
    JSON.stringify(eventWithoutQACheckSnapshot(JSON.parse(row.payload_json))) !==
      JSON.stringify(eventWithoutQACheckSnapshot(event))
  ) {
    throw new Error("Tool event identity was reused for a different event.");
  }
  return row;
}

export function recordAgentEvent(event: AgentEvent, options?: { idempotencyKey?: string }): number {
  if (options?.idempotencyKey !== undefined) {
    if (!options.idempotencyKey.trim()) {
      throw new Error("Agent event idempotency key cannot be empty.");
    }
    const id = `event:${createHash("sha256").update(options.idempotencyKey).digest("hex")}`;
    const db = getDatabase();
    const eventIdentity = JSON.stringify(eventWithoutQACheckSnapshot(event));
    const existingBeforeInsert = db
      .prepare("select rowid, session_id, type, payload_json from agent_events where id = ?")
      .get(id) as
      | { rowid: number; session_id: string; type: string; payload_json: string }
      | undefined;
    if (existingBeforeInsert) {
      const existingEvent = JSON.parse(existingBeforeInsert.payload_json) as Record<
        string,
        unknown
      >;
      delete existingEvent[QA_CHECK_SNAPSHOT_FIELD];
      delete existingEvent[QA_CHECK_CONFIG_STABLE_FIELD];
      delete existingEvent[QA_CHECK_SOURCE_STABLE_FIELD];
      delete existingEvent[QA_CHECK_SOURCE_REVISION_FIELD];
      if (
        existingBeforeInsert.session_id !== event.sessionId ||
        existingBeforeInsert.type !== event.type ||
        JSON.stringify(existingEvent) !== eventIdentity
      ) {
        throw new Error("Agent event idempotency key was reused for a different event.");
      }
      return Number(existingBeforeInsert.rowid);
    }
    // Bind a new delivery key to the original payload; never recompute QA on replay.
    const originalToolEvent = existingToolLifecycleEvent(event, db);
    const payload = originalToolEvent?.payload_json ?? serializeAgentEvent(event, db);
    db.prepare(
      `insert into agent_events (id, session_id, type, payload_json, created_at)
       values (?, ?, ?, ?, ?)
       on conflict(id) do nothing`,
    ).run(id, event.sessionId, event.type, payload, new Date().toISOString());
    const existing = db
      .prepare("select rowid, session_id, type, payload_json from agent_events where id = ?")
      .get(id) as
      | { rowid: number; session_id: string; type: string; payload_json: string }
      | undefined;
    if (!existing) throw new Error("Idempotent agent event could not be read after insertion.");
    const existingEvent = JSON.parse(existing.payload_json) as Record<string, unknown>;
    delete existingEvent[QA_CHECK_SNAPSHOT_FIELD];
    delete existingEvent[QA_CHECK_CONFIG_STABLE_FIELD];
    delete existingEvent[QA_CHECK_SOURCE_STABLE_FIELD];
    delete existingEvent[QA_CHECK_SOURCE_REVISION_FIELD];
    if (
      existing.session_id !== event.sessionId ||
      existing.type !== event.type ||
      JSON.stringify(existingEvent) !== eventIdentity
    ) {
      throw new Error("Agent event idempotency key was reused for a different event.");
    }
    return Number(existing.rowid);
  }

  const db = getDatabase();
  const originalToolEvent = existingToolLifecycleEvent(event, db);
  if (originalToolEvent) return Number(originalToolEvent.rowid);
  const insertResult = db
    .prepare(
      `insert into agent_events (id, session_id, type, payload_json, created_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      event.sessionId,
      event.type,
      serializeAgentEvent(event, db),
      new Date().toISOString(),
    );
  return Number(insertResult.lastInsertRowid);
}

/** Read one persisted QA event by durable row identity and exact run ownership. */
export function getHarnessQAEventByRowId(
  rowId: number,
  sessionId: string,
  runId: string,
): Extract<AgentEvent, { type: "harness.qa" }> | undefined {
  if (!Number.isSafeInteger(rowId) || rowId < 1) return undefined;
  const row = getDatabase()
    .prepare(
      "select payload_json from agent_events where rowid = ? and session_id = ? and type = 'harness.qa'",
    )
    .get(rowId, sessionId) as { payload_json: string } | undefined;
  if (!row) return undefined;
  try {
    const event = JSON.parse(row.payload_json) as AgentEvent;
    return event?.type === "harness.qa" &&
      event.sessionId === sessionId &&
      event.runId === runId &&
      event.result !== null &&
      typeof event.result === "object" &&
      Array.isArray(event.result.evidence)
      ? event
      : undefined;
  } catch {
    return undefined;
  }
}

type TaskStateScanRow = { event_rowid: number; payload_bytes: number; workspace_id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validStringArray(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => typeof item === "string" && SAFE_TASK_STATE_ID.test(item))
  );
}

function validTaskStateCriterion(value: unknown): value is HarnessTaskCriterionState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "criterionId",
      "source",
      "status",
      "evidenceEventIds",
      "requiredCheckKinds",
    ])
  )
    return false;
  if (
    typeof value.criterionId !== "string" ||
    !SAFE_TASK_STATE_ID.test(value.criterionId) ||
    (value.source !== "plan" && value.source !== "check") ||
    typeof value.status !== "string" ||
    !TASK_STATE_CRITERION_STATUSES.includes(
      value.status as (typeof TASK_STATE_CRITERION_STATUSES)[number],
    ) ||
    !validStringArray(value.evidenceEventIds, MAX_TASK_STATE_EVIDENCE_PER_CRITERION)
  )
    return false;
  return (
    value.requiredCheckKinds === undefined ||
    (Array.isArray(value.requiredCheckKinds) &&
      value.requiredCheckKinds.length <= TASK_STATE_CHECK_KINDS.length &&
      value.requiredCheckKinds.every((kind) =>
        TASK_STATE_CHECK_KINDS.includes(kind as HarnessTaskCheckKind),
      ))
  );
}

function validTaskStateEvidence(value: unknown): value is HarnessTaskEvidenceRef {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["eventId", "kind", "status", "revision", "criterionId"])
  )
    return false;
  return (
    typeof value.eventId === "string" &&
    SAFE_TASK_STATE_ID.test(value.eventId) &&
    (value.kind === "check" || value.kind === "user_confirmation") &&
    typeof value.status === "string" &&
    TASK_STATE_EVIDENCE_STATUSES.includes(value.status as VerificationEvidenceStatus) &&
    (value.revision === undefined ||
      (typeof value.revision === "string" && SAFE_TASK_STATE_ID.test(value.revision))) &&
    (value.criterionId === undefined ||
      (typeof value.criterionId === "string" && SAFE_TASK_STATE_ID.test(value.criterionId)))
  );
}

function validTaskStateClassification(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "taskType",
      "complexity",
      "risk",
      "confidence",
      "suggestedRole",
      "reasons",
    ])
  ) {
    return false;
  }
  const taskTypes = [...TASK_STATE_ROLES, "implementation", "unknown"];
  return (
    typeof value.taskType === "string" &&
    taskTypes.includes(value.taskType) &&
    (value.complexity === "simple" ||
      value.complexity === "moderate" ||
      value.complexity === "complex") &&
    (value.risk === "low" || value.risk === "medium" || value.risk === "high") &&
    (value.confidence === "low" || value.confidence === "high") &&
    (value.suggestedRole === undefined ||
      (typeof value.suggestedRole === "string" &&
        TASK_STATE_ROLES.includes(value.suggestedRole as (typeof TASK_STATE_ROLES)[number]))) &&
    Array.isArray(value.reasons) &&
    value.reasons.length <= 32 &&
    value.reasons.every((reason) => typeof reason === "string" && reason.length <= 128)
  );
}

function validVerifiedTaskState(
  criteria: HarnessTaskCriterionState[],
  evidenceRefs: HarnessTaskEvidenceRef[],
): boolean {
  return (
    criteria.length > 0 &&
    criteria.every((criterion) => {
      const requiredCheckKinds = criterion.requiredCheckKinds ?? [];
      const evidenceEventIds = new Set(criterion.evidenceEventIds);
      return (
        criterion.status === "verified" &&
        requiredCheckKinds.length > 0 &&
        evidenceEventIds.size >= requiredCheckKinds.length &&
        [...evidenceEventIds].every((eventId) =>
          evidenceRefs.some(
            (evidence) =>
              evidence.eventId === eventId &&
              evidence.kind === "check" &&
              evidence.status === "passed",
          ),
        )
      );
    })
  );
}

function reconstructTaskState(value: unknown): HarnessTaskState | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "sessionId",
      "runId",
      "workspaceId",
      "goalMessageId",
      "planId",
      "planFingerprint",
      "classification",
      "phase",
      "verificationStatus",
      "criteria",
      "constraintRefs",
      "openQuestionRefs",
      "todoIds",
      "hypothesisRefs",
      "evidenceRefs",
      "revision",
      "updatedAt",
    ])
  )
    return undefined;
  const state = value;
  if (
    state.version !== 1 ||
    ![state.sessionId, state.runId, state.workspaceId, state.goalMessageId].every(
      (id) => typeof id === "string" && SAFE_TASK_STATE_ID.test(id),
    ) ||
    (state.planId !== undefined &&
      (typeof state.planId !== "string" || !SAFE_TASK_STATE_ID.test(state.planId))) ||
    (state.planFingerprint !== undefined &&
      (typeof state.planFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(state.planFingerprint))) ||
    !validTaskStateClassification(state.classification) ||
    typeof state.phase !== "string" ||
    !TASK_STATE_PHASES.includes(state.phase as (typeof TASK_STATE_PHASES)[number]) ||
    typeof state.verificationStatus !== "string" ||
    !TASK_STATE_STATUSES.includes(
      state.verificationStatus as (typeof TASK_STATE_STATUSES)[number],
    ) ||
    !Array.isArray(state.criteria) ||
    state.criteria.length > MAX_TASK_STATE_CRITERIA ||
    !state.criteria.every(validTaskStateCriterion) ||
    !validStringArray(state.constraintRefs, MAX_TASK_STATE_REFS) ||
    !validStringArray(state.openQuestionRefs, MAX_TASK_STATE_REFS) ||
    !validStringArray(state.todoIds, MAX_TASK_STATE_REFS) ||
    !validStringArray(state.hypothesisRefs, MAX_TASK_STATE_REFS) ||
    !Array.isArray(state.evidenceRefs) ||
    state.evidenceRefs.length > MAX_TASK_STATE_EVIDENCE ||
    !state.evidenceRefs.every(validTaskStateEvidence) ||
    (state.verificationStatus === "verified" &&
      !validVerifiedTaskState(
        state.criteria as HarnessTaskCriterionState[],
        state.evidenceRefs as HarnessTaskEvidenceRef[],
      )) ||
    (state.revision !== undefined &&
      (typeof state.revision !== "string" || !SAFE_TASK_STATE_ID.test(state.revision))) ||
    typeof state.updatedAt !== "string" ||
    state.updatedAt.length > 64 ||
    !Number.isFinite(Date.parse(state.updatedAt)) ||
    new Date(state.updatedAt).toISOString() !== state.updatedAt
  )
    return undefined;

  return {
    version: 1,
    sessionId: state.sessionId as string,
    runId: state.runId as string,
    workspaceId: state.workspaceId as string,
    goalMessageId: state.goalMessageId as string,
    ...(state.planId !== undefined ? { planId: state.planId as string } : {}),
    ...(state.planFingerprint !== undefined
      ? { planFingerprint: state.planFingerprint as string }
      : {}),
    classification: state.classification as HarnessTaskState["classification"],
    phase: state.phase as HarnessTaskState["phase"],
    verificationStatus: state.verificationStatus as HarnessTaskState["verificationStatus"],
    criteria: state.criteria as HarnessTaskCriterionState[],
    constraintRefs: state.constraintRefs as string[],
    openQuestionRefs: state.openQuestionRefs as string[],
    todoIds: state.todoIds as string[],
    hypothesisRefs: state.hypothesisRefs as string[],
    evidenceRefs: state.evidenceRefs as HarnessTaskEvidenceRef[],
    ...(state.revision !== undefined ? { revision: state.revision as string } : {}),
    updatedAt: state.updatedAt,
  };
}

/** Returns the newest valid snapshot for exactly one run, failing closed on malformed newer data. */
export function getLatestHarnessTaskState(
  sessionId: string,
  runId: string,
): HarnessTaskState | undefined {
  if (!SAFE_TASK_STATE_ID.test(sessionId) || !SAFE_TASK_STATE_ID.test(runId)) return undefined;
  const db = getDatabase();
  const candidates = db
    .prepare(
      `select e.rowid as event_rowid,
            length(cast(e.payload_json as blob)) as payload_bytes,
            s.workspace_id
     from agent_events e
     join agent_sessions s on s.id = e.session_id
     where e.session_id = ? and e.type = 'harness.task_state'
     order by e.rowid desc
     limit ?`,
    )
    .all(sessionId, MAX_TASK_STATE_SCAN) as TaskStateScanRow[];

  for (const candidate of candidates) {
    if (candidate.workspace_id === CHATS_WORKSPACE_ID) return undefined;
    if (
      !Number.isSafeInteger(candidate.payload_bytes) ||
      candidate.payload_bytes > MAX_TASK_STATE_EVENT_BYTES
    ) {
      return undefined;
    }
    const row = db
      .prepare("select payload_json from agent_events where rowid = ?")
      .get(candidate.event_rowid) as { payload_json: string } | undefined;
    if (!row || typeof row.payload_json !== "string") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json);
    } catch {
      return undefined;
    }
    if (
      !isRecord(parsed) ||
      !hasOnlyKeys(parsed, ["type", "sessionId", "runId", "state"]) ||
      parsed.type !== "harness.task_state" ||
      parsed.sessionId !== sessionId ||
      typeof parsed.runId !== "string" ||
      !SAFE_TASK_STATE_ID.test(parsed.runId) ||
      !("state" in parsed)
    ) {
      return undefined;
    }
    const state = reconstructTaskState(parsed.state);
    if (
      !state ||
      state.sessionId !== sessionId ||
      state.runId !== parsed.runId ||
      state.workspaceId !== candidate.workspace_id
    ) {
      return undefined;
    }
    if (parsed.runId !== runId) continue;
    const ownedRun = db
      .prepare("select 1 from agent_runs where id = ? and session_id = ? limit 1")
      .get(runId, sessionId);
    if (!ownedRun) return undefined;
    return state;
  }
  return undefined;
}

/** Latest restore boundary strictly after the run's persisted start event. */
export function getLatestCheckpointRestoreRowId(
  sessionId: string,
  runStartedRowId: number,
): number | undefined {
  if (
    !SAFE_TASK_STATE_ID.test(sessionId) ||
    !Number.isSafeInteger(runStartedRowId) ||
    runStartedRowId <= 0
  ) {
    return undefined;
  }
  const row = getDatabase()
    .prepare(
      `select rowid
     from agent_events
     where session_id = ? and type = 'checkpoint.restored' and rowid > ?
     order by rowid desc
     limit 1`,
    )
    .get(sessionId, runStartedRowId) as { rowid: number } | undefined;
  return row?.rowid;
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
 * Return a bounded, redacted tool-call projection for one exact run. Persisted
 * starts supply their frozen classification; legacy starts only use direct
 * command recognition. This projection never reads the current package files.
 * The query never joins or reads agent_runs, so prompt/transcript text cannot enter QA.
 */
export function getRunToolEvidence(
  sessionId: string,
  runId: string,
  afterRowId?: number,
): RunQAEvent[] {
  if (afterRowId !== undefined && (!Number.isSafeInteger(afterRowId) || afterRowId <= 0)) return [];
  const rows = getDatabase()
    .prepare(
      `select e.id, e.payload_json from agent_events e
       where e.session_id = ? and e.type in ('tool.started', 'tool.ended')
         and json_extract(e.payload_json, '$.runId') = ?
         and (? is null or e.rowid > ?)
         and not exists (
           select 1 from agent_events original
           where original.session_id = e.session_id and original.type = e.type
             and original.rowid < e.rowid
             and json_extract(original.payload_json, '$.runId') = json_extract(e.payload_json, '$.runId')
             and json_extract(original.payload_json, '$.toolCallId') = json_extract(e.payload_json, '$.toolCallId')
         )
       order by e.rowid desc
       limit ?`,
    )
    .all(sessionId, runId, afterRowId ?? null, afterRowId ?? null, MAX_RUN_TOOL_EVENTS)
    .reverse() as Array<{ id: string; payload_json: string }>;

  const starts = new Map<
    string,
    {
      toolName: string;
      checkName?: string;
      paths?: string[];
      fullProject?: boolean;
      mutatesSource?: boolean;
      packageConfigDigest?: string;
      workspaceRevision?: string;
    }
  >();
  const evidence: RunQAEvent[] = [];
  for (const row of rows) {
    let payload: Record<string, unknown>;
    let event: AgentEvent;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!isRecord(parsed)) continue;
      payload = parsed;
      event = parsed as unknown as AgentEvent;
    } catch {
      continue;
    }
    if (event.sessionId !== sessionId || !("runId" in event) || event.runId !== runId) continue;
    if (event.type === "tool.started") {
      const args = toolArgs(event);
      const snapshot = readQACheckSnapshot(payload);
      const legacyInvocation =
        snapshot.state === "missing"
          ? recognizeCheckInvocation(
              event.toolName,
              typeof args.command === "string" ? args.command : undefined,
            )
          : undefined;
      const checkName =
        snapshot.state === "valid" ? snapshot.snapshot.checkName : legacyInvocation?.checkName;
      const paths =
        snapshot.state === "valid"
          ? snapshot.snapshot.paths
          : snapshot.state === "missing"
            ? (legacyInvocation?.paths ?? (checkName ? safeToolPaths(args) : undefined))
            : undefined;
      const fullProject =
        checkName && !paths
          ? snapshot.state === "valid"
            ? snapshot.snapshot.fullProject
            : snapshot.state === "missing"
              ? legacyInvocation?.fullProject
              : false
          : false;
      const mutatesSource =
        snapshot.state === "valid"
          ? snapshot.snapshot.mutatesSource
          : snapshot.state === "missing"
            ? legacyInvocation?.mutatesSource
            : undefined;
      starts.set(event.toolCallId, {
        toolName: event.toolName,
        ...(checkName ? { checkName } : {}),
        ...(paths ? { paths } : {}),
        ...(fullProject ? { fullProject: true } : {}),
        ...(mutatesSource ? { mutatesSource: true } : {}),
        ...(snapshot.state === "valid" && snapshot.snapshot.packageConfigDigest
          ? { packageConfigDigest: snapshot.snapshot.packageConfigDigest }
          : {}),
        ...(snapshot.state === "valid" && snapshot.snapshot.workspaceRevision
          ? { workspaceRevision: snapshot.snapshot.workspaceRevision }
          : {}),
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
        ...(snapshot.state === "valid" && snapshot.snapshot.workspaceRevision
          ? { workspaceRevision: snapshot.snapshot.workspaceRevision }
          : {}),
      });
      continue;
    }
    if (event.type !== "tool.ended") continue;
    const started = starts.get(event.toolCallId);
    if (!started || (event.toolName && started.toolName !== event.toolName)) continue;
    const checkConfigStable =
      started.packageConfigDigest !== undefined
        ? payload[QA_CHECK_CONFIG_STABLE_FIELD] === true
        : undefined;
    const sourceStable = payload[QA_CHECK_SOURCE_STABLE_FIELD];
    const sourceRevision = payload[QA_CHECK_SOURCE_REVISION_FIELD];
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
      ...(started.workspaceRevision ? { workspaceRevision: started.workspaceRevision } : {}),
      ...(checkConfigStable !== undefined ? { checkConfigStable } : {}),
      ...(typeof sourceStable === "boolean" ? { sourceStable } : {}),
      ...(typeof sourceRevision === "string" ? { workspaceRevision: sourceRevision } : {}),
      ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
      error: event.isError,
      ...(event.aborted ? { aborted: true } : {}),
      ...(event.timedOut ? { timedOut: true } : {}),
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
              json_extract(e.payload_json, '$.timedOut') as timed_out,
              json_type(e.payload_json, '$.timedOut') as timed_out_type,
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
           'harness.decision', 'harness.failure',
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
    const timedOut = sqliteBoolean(row.timed_out, row.timed_out_type);
    if (timedOut !== undefined) result.timedOut = timedOut;
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
      `select id, payload_json, created_at, rowid as event_cursor
       from agent_events
       where session_id = ?
       order by created_at asc, rowid asc`,
    )
    .all(sessionId) as AgentEventRow[];
  const events = rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    delete payload[QA_CHECK_SNAPSHOT_FIELD];
    delete payload[QA_CHECK_CONFIG_STABLE_FIELD];
    delete payload[QA_CHECK_SOURCE_STABLE_FIELD];
    delete payload[QA_CHECK_SOURCE_REVISION_FIELD];
    return {
      id: row.id,
      event: { ...payload, eventCursor: row.event_cursor } as AgentEvent,
      createdAt: row.created_at,
    };
  });
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
