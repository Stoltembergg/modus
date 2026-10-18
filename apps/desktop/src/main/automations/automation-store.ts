import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ThinkingLevel } from "../../shared/contracts";
import { type AutomationSchedule, nextAutomationOccurrence } from "./automation-schedule";
import type {
  AutomationConfigSnapshot,
  AutomationDefinition,
  AutomationExecution,
  AutomationExecutionStatus,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "./automation-types";

type AutomationRow = {
  id: string;
  revision: number;
  name: string;
  instruction: string;
  schedule_json: string;
  time_zone: string;
  next_occurrence_at: string | null;
  workspace_id: string;
  cwd: string;
  agent_id: string | null;
  provider_id: string;
  model_id: string;
  thinking_level: string;
  thinking_variant: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type ExecutionRow = {
  id: string;
  automation_id: string;
  automation_revision: number;
  trigger_key: string;
  trigger_kind: AutomationExecution["triggerKind"];
  scheduled_for: string | null;
  config_snapshot_json: string;
  status: AutomationExecutionStatus;
  session_id: string | null;
  run_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  missed_first: string | null;
  missed_last: string | null;
  missed_count: number | null;
};

export class AutomationStoreError extends Error {
  constructor(
    readonly code:
      | "not-found"
      | "revision-conflict"
      | "invalid-value"
      | "active-execution"
      | "invalid-transition"
      | "corrupt-record",
    message: string,
  ) {
    super(message);
    this.name = "AutomationStoreError";
  }
}

export type ClaimOccurrenceInput = {
  automationId: string;
  expectedRevision: number;
  triggerKey: string;
  triggerKind: "scheduled" | "manual";
  scheduledFor: string | null;
  nextOccurrenceAt?: string | null;
  occurredAt: string;
};

export type ClaimOccurrenceResult = {
  kind: "claimed" | "skipped" | "duplicate" | "busy" | "stale" | "disabled" | "not-due";
  execution?: AutomationExecution;
};

export type MissedIntervalInput = {
  automationId: string;
  expectedRevision: number;
  first: string;
  last: string;
  count: number;
  nextOccurrenceAt: string | null;
  through: string;
};

const ACTIVE_STATUSES: AutomationExecutionStatus[] = [
  "claimed",
  "running",
  "waiting_for_you",
  "cancelling",
  "cleanup_failed",
];
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const MAX_ERROR_LENGTH = 1000;

export function createAutomationStore(
  db: DatabaseSync,
  now: () => string = () => new Date().toISOString(),
) {
  return {
    createDefinition(input: CreateAutomationInput): AutomationDefinition {
      const timestamp = canonicalInstant(now(), "now");
      const normalized = normalizeConfig(input);
      const nextOccurrenceAt = nextAutomationOccurrence(
        normalized.schedule,
        normalized.timeZone,
        timestamp,
      );
      const id = randomUUID();
      db.prepare(
        `insert into automations (
          id, revision, name, instruction, schedule_json, time_zone, next_occurrence_at,
          workspace_id, cwd, agent_id, provider_id, model_id, thinking_level, thinking_variant,
          enabled, created_at, updated_at
        ) values (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        normalized.name,
        normalized.instruction,
        JSON.stringify(normalized.schedule),
        normalized.timeZone,
        nextOccurrenceAt,
        normalized.workspaceId,
        normalized.cwd,
        normalized.agentId,
        normalized.providerId,
        normalized.modelId,
        normalized.thinkingLevel,
        normalized.thinkingVariant ?? null,
        normalized.enabled ? 1 : 0,
        timestamp,
        timestamp,
      );
      return requireDefinition(db, id);
    },

    getDefinition(id: string): AutomationDefinition | null {
      return readDefinition(db, id);
    },

    listDefinitions(): AutomationDefinition[] {
      const rows = db
        .prepare(
          "select * from automations where deleted_at is null order by name collate nocase, id",
        )
        .all() as AutomationRow[];
      return rows.map(mapDefinition);
    },

    updateDefinition(
      id: string,
      expectedRevision: number,
      patch: UpdateAutomationInput,
    ): AutomationDefinition {
      const current = requireDefinition(db, id);
      if (current.revision !== expectedRevision) {
        throw new AutomationStoreError(
          "revision-conflict",
          "This automation changed. Reload it and try again.",
        );
      }
      const nextTimeZone = patch.timeZone ?? current.timeZone;
      const nextSchedule = patch.schedule ?? current.schedule;
      const { thinkingVariant: patchThinkingVariant, ...patchWithoutThinkingVariant } = patch;
      const thinkingVariant =
        patchThinkingVariant === null
          ? undefined
          : (patchThinkingVariant ?? current.thinkingVariant);
      const configWithoutThinkingVariant = snapshotFromDefinition(current);
      delete configWithoutThinkingVariant.thinkingVariant;
      const updated = normalizeConfig({
        ...configWithoutThinkingVariant,
        ...patchWithoutThinkingVariant,
        timeZone: nextTimeZone,
        schedule: nextSchedule,
        enabled: current.enabled,
        ...(thinkingVariant !== undefined ? { thinkingVariant } : {}),
      });
      const scheduleChanged = patch.schedule !== undefined || patch.timeZone !== undefined;
      const timestamp = canonicalInstant(now(), "now");
      const nextOccurrenceAt = scheduleChanged
        ? nextAutomationOccurrence(updated.schedule, updated.timeZone, timestamp)
        : current.nextOccurrenceAt;
      db.prepare(
        `update automations set revision = revision + 1, name = ?, instruction = ?, schedule_json = ?,
          time_zone = ?, next_occurrence_at = ?, workspace_id = ?, cwd = ?, agent_id = ?,
          provider_id = ?, model_id = ?, thinking_level = ?, thinking_variant = ?, updated_at = ?
         where id = ? and revision = ? and deleted_at is null`,
      ).run(
        updated.name,
        updated.instruction,
        JSON.stringify(updated.schedule),
        updated.timeZone,
        nextOccurrenceAt,
        updated.workspaceId,
        updated.cwd,
        updated.agentId,
        updated.providerId,
        updated.modelId,
        updated.thinkingLevel,
        updated.thinkingVariant ?? null,
        timestamp,
        id,
        expectedRevision,
      );
      return requireDefinition(db, id);
    },

    setEnabled(id: string, enabled: boolean): AutomationDefinition {
      const current = requireDefinition(db, id);
      const timestamp = canonicalInstant(now(), "now");
      const nextOccurrenceAt = enabled
        ? nextAutomationOccurrence(current.schedule, current.timeZone, timestamp)
        : null;
      db.prepare(
        `update automations set revision = revision + 1, enabled = ?, next_occurrence_at = ?, updated_at = ?
         where id = ? and deleted_at is null`,
      ).run(enabled ? 1 : 0, nextOccurrenceAt, timestamp, id);
      return requireDefinition(db, id);
    },

    softDeleteDefinition(id: string, deletedAt = now()): void {
      withImmediateTransaction(db, () => {
        requireDefinition(db, id);
        if (hasActiveExecution(db, id)) {
          throw new AutomationStoreError(
            "active-execution",
            "Stop this automation and wait for it to finish before deleting it.",
          );
        }
        db.prepare(
          `update automations set revision = revision + 1, enabled = 0, next_occurrence_at = null,
             deleted_at = ?, updated_at = ? where id = ? and deleted_at is null`,
        ).run(
          canonicalInstant(deletedAt, "deletedAt"),
          canonicalInstant(deletedAt, "deletedAt"),
          id,
        );
      });
    },

    claimOccurrence(input: ClaimOccurrenceInput): ClaimOccurrenceResult {
      return withImmediateTransaction(db, () => claimOccurrence(db, input, now));
    },

    recordMissedInterval(input: MissedIntervalInput): AutomationExecution | null {
      return withImmediateTransaction(db, () => {
        if (!Number.isInteger(input.count) || input.count < 1) {
          throw new AutomationStoreError(
            "invalid-value",
            "A missed interval must contain at least one occurrence.",
          );
        }
        const first = canonicalInstant(input.first, "first");
        const last = canonicalInstant(input.last, "last");
        const through = canonicalInstant(input.through, "through");
        if (Date.parse(last) < Date.parse(first) || Date.parse(through) < Date.parse(last)) {
          throw new AutomationStoreError(
            "invalid-value",
            "The missed interval dates are out of order.",
          );
        }
        const triggerKey = `missed:${input.automationId}:${first}:${last}`;
        const existing = readExecutionByTriggerKey(db, triggerKey);
        if (existing) return existing;
        const definition = readDefinition(db, input.automationId);
        if (
          !definition ||
          definition.revision !== input.expectedRevision ||
          !definition.enabled ||
          definition.nextOccurrenceAt !== first
        ) {
          return null;
        }
        const createdAt = canonicalInstant(now(), "now");
        const id = randomUUID();
        db.prepare(
          `insert into automation_executions (
            id, automation_id, automation_revision, trigger_key, trigger_kind, scheduled_for,
            config_snapshot_json, status, created_at, completed_at, missed_first, missed_last, missed_count
          ) values (?, ?, ?, ?, 'missed_interval', ?, ?, 'missed', ?, ?, ?, ?, ?)`,
        ).run(
          id,
          definition.id,
          definition.revision,
          triggerKey,
          first,
          JSON.stringify(snapshotFromDefinition(definition)),
          createdAt,
          createdAt,
          first,
          last,
          input.count,
        );
        db.prepare(
          `update automations set next_occurrence_at = ?, updated_at = ? where id = ? and revision = ?`,
        ).run(
          input.nextOccurrenceAt === null
            ? null
            : canonicalInstant(input.nextOccurrenceAt, "nextOccurrenceAt"),
          createdAt,
          definition.id,
          definition.revision,
        );
        return requireExecution(db, id);
      });
    },

    attachSession(executionId: string, sessionId: string, startedAt = now()): AutomationExecution {
      const timestamp = canonicalInstant(startedAt, "startedAt");
      db.prepare(
        `update automation_executions set session_id = ?, status = 'running', started_at = ?
         where id = ? and status = 'claimed'`,
      ).run(requireText(sessionId, "sessionId", 128), timestamp, executionId);
      return requireExecution(db, executionId);
    },

    attachRun(executionId: string, runId: string): AutomationExecution {
      db.prepare("update automation_executions set run_id = ? where id = ?").run(
        requireText(runId, "runId", 128),
        executionId,
      );
      return requireExecution(db, executionId);
    },

    setExecutionStatus(
      executionId: string,
      status: AutomationExecutionStatus,
      input: { at?: string; error?: string } = {},
    ): AutomationExecution {
      const at = canonicalInstant(input.at ?? now(), "at");
      const terminal = isTerminalStatus(status);
      const error = input.error === undefined ? null : input.error.slice(0, MAX_ERROR_LENGTH);
      const result = db
        .prepare(
          `update automation_executions set status = ?, completed_at = ?, error = coalesce(?, error)
           where id = ? and status in ('claimed', 'running', 'waiting_for_you', 'cancelling', 'cleanup_failed')`,
        )
        .run(status, terminal ? at : null, error, executionId);
      if (Number(result.changes) === 0) {
        const existing = requireExecution(db, executionId);
        if (existing.status !== status) {
          throw new AutomationStoreError(
            "invalid-transition",
            `Cannot change execution from ${existing.status} to ${status}.`,
          );
        }
      }
      return requireExecution(db, executionId);
    },

    listHistory(automationId: string, limit = 100): AutomationExecution[] {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const rows = db
        .prepare(
          `select * from automation_executions where automation_id = ?
           order by created_at desc, id desc limit ?`,
        )
        .all(automationId, safeLimit) as ExecutionRow[];
      return rows.map(mapExecution);
    },

    listUnresolvedExecutions(): AutomationExecution[] {
      const rows = db
        .prepare(
          `select * from automation_executions where status in (${ACTIVE_STATUSES.map(() => "?").join(",")})
           order by created_at asc`,
        )
        .all(...ACTIVE_STATUSES) as ExecutionRow[];
      return rows.map(mapExecution);
    },

    reconcileUnresolved(at = now()): number {
      const timestamp = canonicalInstant(at, "at");
      const result = db
        .prepare(
          `update automation_executions set status = 'interrupted', completed_at = ?,
             error = coalesce(error, 'Execution interrupted when Modus closed.')
           where status in (${ACTIVE_STATUSES.map(() => "?").join(",")})`,
        )
        .run(timestamp, ...ACTIVE_STATUSES);
      return Number(result.changes);
    },
  };
}

function claimOccurrence(
  db: DatabaseSync,
  input: ClaimOccurrenceInput,
  now: () => string,
): ClaimOccurrenceResult {
  const triggerKey = requireText(input.triggerKey, "triggerKey", 256);
  const duplicate = readExecutionByTriggerKey(db, triggerKey);
  if (duplicate) return { kind: "duplicate", execution: duplicate };

  const definition = readDefinition(db, input.automationId);
  if (!definition || definition.revision !== input.expectedRevision) return { kind: "stale" };
  if (!definition.enabled) return { kind: "disabled" };
  const occurredAt = canonicalInstant(input.occurredAt, "occurredAt");

  if (input.triggerKind === "scheduled") {
    if (!input.scheduledFor || (!input.nextOccurrenceAt && input.nextOccurrenceAt !== null)) {
      throw new AutomationStoreError(
        "invalid-value",
        "Scheduled occurrence requires its due and next instants.",
      );
    }
    const scheduledFor = canonicalInstant(input.scheduledFor, "scheduledFor");
    if (definition.nextOccurrenceAt !== scheduledFor) return { kind: "stale" };
    if (Date.parse(scheduledFor) > Date.parse(occurredAt)) return { kind: "not-due" };
  } else if (input.scheduledFor !== null) {
    throw new AutomationStoreError(
      "invalid-value",
      "Manual executions cannot include a scheduled instant.",
    );
  }

  const createdAt = canonicalInstant(now(), "now");
  const busy = hasActiveExecution(db);
  if (busy && input.triggerKind === "manual") return { kind: "busy" };

  const status: AutomationExecutionStatus = busy ? "skipped" : "claimed";
  const id = randomUUID();
  db.prepare(
    `insert into automation_executions (
      id, automation_id, automation_revision, trigger_key, trigger_kind, scheduled_for,
      config_snapshot_json, status, created_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    definition.id,
    definition.revision,
    triggerKey,
    input.triggerKind,
    input.scheduledFor === null ? null : canonicalInstant(input.scheduledFor, "scheduledFor"),
    JSON.stringify(snapshotFromDefinition(definition)),
    status,
    createdAt,
    busy ? createdAt : null,
  );

  if (input.triggerKind === "scheduled") {
    db.prepare(
      `update automations set next_occurrence_at = ?, updated_at = ?
       where id = ? and revision = ? and next_occurrence_at = ?`,
    ).run(
      input.nextOccurrenceAt === null
        ? null
        : canonicalInstant(input.nextOccurrenceAt ?? "", "nextOccurrenceAt"),
      createdAt,
      definition.id,
      definition.revision,
      input.scheduledFor,
    );
  }

  return {
    kind: status === "skipped" ? "skipped" : "claimed",
    execution: requireExecution(db, id),
  };
}

function normalizeConfig(input: CreateAutomationInput): CreateAutomationInput {
  const name = requireText(input.name, "name", 120);
  const instruction = requireText(input.instruction, "instruction", 65_536);
  const timeZone = requireText(input.timeZone, "timeZone", 128);
  // This validates the timezone and schedule shape without changing the selected schedule.
  nextAutomationOccurrence(input.schedule, timeZone, "2000-01-01T00:00:00.000Z");
  const workspaceId = requireText(input.workspaceId, "workspaceId", 128);
  const cwd = requireText(input.cwd, "cwd", 4096);
  const providerId = requireText(input.providerId, "providerId", 128);
  const modelId = requireText(input.modelId, "modelId", 256);
  if (input.agentId !== null) requireText(input.agentId, "agentId", 128);
  if (!THINKING_LEVELS.has(input.thinkingLevel)) {
    throw new AutomationStoreError("invalid-value", "Choose a supported thinking level.");
  }
  const thinkingVariant = input.thinkingVariant?.trim();
  if (thinkingVariant && thinkingVariant.length > 128) {
    throw new AutomationStoreError("invalid-value", "Thinking variant is too long.");
  }
  if (typeof input.enabled !== "boolean") {
    throw new AutomationStoreError("invalid-value", "Enabled state must be explicit.");
  }
  return {
    ...input,
    name,
    instruction,
    schedule: structuredClone(input.schedule),
    timeZone,
    workspaceId,
    cwd,
    agentId: input.agentId?.trim() || null,
    providerId,
    modelId,
    ...(thinkingVariant ? { thinkingVariant } : {}),
  };
}

function snapshotFromDefinition(definition: AutomationDefinition): AutomationConfigSnapshot {
  return {
    name: definition.name,
    instruction: definition.instruction,
    schedule: structuredClone(definition.schedule),
    timeZone: definition.timeZone,
    workspaceId: definition.workspaceId,
    cwd: definition.cwd,
    agentId: definition.agentId,
    providerId: definition.providerId,
    modelId: definition.modelId,
    thinkingLevel: definition.thinkingLevel,
    ...(definition.thinkingVariant ? { thinkingVariant: definition.thinkingVariant } : {}),
  };
}

function requireText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > maxLength) {
    throw new AutomationStoreError(
      "invalid-value",
      `${field} must contain between 1 and ${maxLength} characters.`,
    );
  }
  return value.trim();
}

function canonicalInstant(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new AutomationStoreError("invalid-value", `${field} must be a valid date-time.`);
  }
  return new Date(timestamp).toISOString();
}

function readDefinition(db: DatabaseSync, id: string): AutomationDefinition | null {
  const row = db.prepare("select * from automations where id = ? and deleted_at is null").get(id) as
    | AutomationRow
    | undefined;
  return row ? mapDefinition(row) : null;
}

function requireDefinition(db: DatabaseSync, id: string): AutomationDefinition {
  const definition = readDefinition(db, id);
  if (!definition) throw new AutomationStoreError("not-found", "Automation not found.");
  return definition;
}

function mapDefinition(row: AutomationRow): AutomationDefinition {
  try {
    return {
      id: row.id,
      revision: Number(row.revision),
      name: row.name,
      instruction: row.instruction,
      schedule: JSON.parse(row.schedule_json) as AutomationSchedule,
      timeZone: row.time_zone,
      nextOccurrenceAt: row.next_occurrence_at,
      workspaceId: row.workspace_id,
      cwd: row.cwd,
      agentId: row.agent_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      thinkingLevel: row.thinking_level as ThinkingLevel,
      ...(row.thinking_variant ? { thinkingVariant: row.thinking_variant } : {}),
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    };
  } catch {
    throw new AutomationStoreError("corrupt-record", "Automation data could not be read.");
  }
}

function readExecutionByTriggerKey(
  db: DatabaseSync,
  triggerKey: string,
): AutomationExecution | null {
  const row = db
    .prepare("select * from automation_executions where trigger_key = ?")
    .get(triggerKey) as ExecutionRow | undefined;
  return row ? mapExecution(row) : null;
}

function requireExecution(db: DatabaseSync, id: string): AutomationExecution {
  const row = db.prepare("select * from automation_executions where id = ?").get(id) as
    | ExecutionRow
    | undefined;
  if (!row) throw new AutomationStoreError("not-found", "Automation execution not found.");
  return mapExecution(row);
}

function mapExecution(row: ExecutionRow): AutomationExecution {
  try {
    const config = JSON.parse(row.config_snapshot_json) as AutomationConfigSnapshot;
    return {
      id: row.id,
      automationId: row.automation_id,
      automationRevision: Number(row.automation_revision),
      triggerKey: row.trigger_key,
      triggerKind: row.trigger_kind,
      scheduledFor: row.scheduled_for,
      config,
      status: row.status,
      sessionId: row.session_id,
      runId: row.run_id,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      ...(row.error ? { error: row.error } : {}),
      ...(row.missed_first ? { missedFirst: row.missed_first } : {}),
      ...(row.missed_last ? { missedLast: row.missed_last } : {}),
      ...(row.missed_count ? { missedCount: Number(row.missed_count) } : {}),
    };
  } catch {
    throw new AutomationStoreError(
      "corrupt-record",
      "Automation execution data could not be read.",
    );
  }
}

function hasActiveExecution(db: DatabaseSync, automationId?: string): boolean {
  const where = `status in (${ACTIVE_STATUSES.map(() => "?").join(",")})`;
  const query = automationId
    ? `select 1 as found from automation_executions where ${where} and automation_id = ? limit 1`
    : `select 1 as found from automation_executions where ${where} limit 1`;
  const row = automationId
    ? db.prepare(query).get(...ACTIVE_STATUSES, automationId)
    : db.prepare(query).get(...ACTIVE_STATUSES);
  return Boolean(row);
}

function isTerminalStatus(status: AutomationExecutionStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted", "skipped", "missed"].includes(status);
}

function withImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("begin immediate");
  try {
    const result = operation();
    db.exec("commit");
    return result;
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // Preserve the failure that caused the rollback.
    }
    throw error;
  }
}
