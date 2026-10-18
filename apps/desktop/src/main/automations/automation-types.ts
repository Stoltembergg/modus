import type { ThinkingLevel } from "../../shared/contracts";
import type { AutomationSchedule } from "./automation-schedule";

export type AutomationDefinition = {
  id: string;
  revision: number;
  name: string;
  instruction: string;
  schedule: AutomationSchedule;
  timeZone: string;
  nextOccurrenceAt: string | null;
  workspaceId: string;
  cwd: string;
  agentId: string | null;
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  thinkingVariant?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type AutomationConfigSnapshot = Pick<
  AutomationDefinition,
  | "name"
  | "instruction"
  | "schedule"
  | "timeZone"
  | "workspaceId"
  | "cwd"
  | "agentId"
  | "providerId"
  | "modelId"
  | "thinkingLevel"
  | "thinkingVariant"
>;

export type AutomationExecutionStatus =
  | "claimed"
  | "running"
  | "waiting_for_you"
  | "cancelling"
  | "cleanup_failed"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "skipped"
  | "missed";

export type AutomationExecution = {
  id: string;
  automationId: string;
  automationRevision: number;
  triggerKey: string;
  triggerKind: "scheduled" | "manual" | "missed_interval";
  scheduledFor: string | null;
  config: AutomationConfigSnapshot;
  status: AutomationExecutionStatus;
  sessionId: string | null;
  runId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error?: string;
  missedFirst?: string;
  missedLast?: string;
  missedCount?: number;
};

export type CreateAutomationInput = Omit<
  AutomationDefinition,
  "id" | "revision" | "nextOccurrenceAt" | "createdAt" | "updatedAt" | "deletedAt"
>;

export type UpdateAutomationInput = Partial<
  Omit<
    Pick<
      AutomationDefinition,
      | "name"
      | "instruction"
      | "schedule"
      | "timeZone"
      | "workspaceId"
      | "cwd"
      | "agentId"
      | "providerId"
      | "modelId"
      | "thinkingLevel"
      | "thinkingVariant"
    >,
    "thinkingVariant"
  >
> & { thinkingVariant?: string | null };
