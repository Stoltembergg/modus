/** Gap 4 contracts split part 8 — Agent Groups DTOs from #62 */
import type {
  GroupTaskCriterion,
  GroupTaskEvidenceRef,
  GroupTaskKind,
  GroupTaskPriority,
  GroupTaskReview,
  GroupTaskStage,
  GroupTaskVerificationPolicy,
} from "../group-work-state";
/* ── Agent Groups (rooms of normal agent sessions) ─────────────────────── */

export type AgentGroupMode = "free" | "coordinator";

export type AgentGroupInfo = {
  id: string;
  name: string;
  /** Owning Project; absent means "no Project" (members live in the Chats inbox). */
  workspaceId?: string;
  mode: AgentGroupMode;
  leadSessionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentGroupMember = {
  groupId: string;
  /** The pair's hidden room session (kind 'group_member'): the runtime's member key. */
  sessionId: string;
  /** Free-form per-group role label, e.g. research / plan / implement / review / verify. */
  role?: string;
  /** The agent this member is (agents model). */
  agentId: string;
  /** The agent's name: what the room, mentions and the sidebar show. */
  name: string;
  /** The agent's role label ("" when unset). */
  agentRole: string;
  /** The agent is archived: still a member, never woken. */
  archived?: true;
  /** The agent's avatar (A3); the renderer falls back to agentAvatarForId(agentId). */
  avatarFace?: AgentAvatarFace;
  avatarColor?: AgentAvatarColor;
  avatarShape?: AgentAvatarShape;
  joinedAt: string;
};

/* ── Agents (independent entities that meet in groups) ──────────────────── */

/** The 8 avatar faces (the SVG `AgentAvatar` draws them; A3). */
export const AGENT_AVATAR_FACES = [
  "happy",
  "curious",
  "sleepy",
  "wink",
  "focused",
  "cheeky",
  "calm",
  "bright",
] as const;
export type AgentAvatarFace = (typeof AGENT_AVATAR_FACES)[number];

/**
 * Avatar fill tokens (N5). Each maps to a bg/ink pair in the renderer for
 * accessible contrast; names stay stable for deterministic id-derivation.
 */
export const AGENT_AVATAR_COLORS = [
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
  "rose",
  "fuchsia",
  "indigo",
  "cyan",
  "emerald",
  "yellow",
  "stone",
  "slate",
  "coral",
  "mint",
  "grape",
  "navy",
] as const;
export type AgentAvatarColor = (typeof AGENT_AVATAR_COLORS)[number];

/** Silhouette shapes for AgentAvatar (N5) — not limited to circles. */
export const AGENT_AVATAR_SHAPES = [
  "circle",
  "squircle",
  "roundedSquare",
  "hexagon",
  "capsule",
  "blob",
  "diamond",
  "shield",
  "triangle",
  "pentagon",
] as const;
export type AgentAvatarShape = (typeof AGENT_AVATAR_SHAPES)[number];

/** An agent: belongs to ONE group, name unique in it (case-insensitive), persona and defaults. */
export type AgentInfo = {
  id: string;
  /** Its group (A2). Absent only for legacy agents that had no membership. */
  groupId?: string;
  name: string;
  /** Short label, e.g. "Reviewer"; "" when unset. */
  role: string;
  /** The persona (long); "" when unset. */
  instructions: string;
  modelId?: string;
  /** Default Project for the agent's 1:1 chat. */
  defaultWorkspaceId?: string;
  avatarFace: AgentAvatarFace;
  avatarColor: AgentAvatarColor;
  avatarShape: AgentAvatarShape;
  /** The template this agent was copied from (shared/agent-templates.ts), if any. */
  templateId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

/** `agents:create` payload. */
export type CreateAgentInput = {
  name: string;
  role?: string;
  instructions?: string;
  modelId?: string | null;
  defaultWorkspaceId?: string | null;
  /** Default: derived from the agent id (see agentAvatarForId). */
  avatarFace?: AgentAvatarFace;
  avatarColor?: AgentAvatarColor;
  avatarShape?: AgentAvatarShape;
};

/**
 * An agent created inside a group (`agents:create`, and each entry of
 * `group:create`). Without `templateId` a `modelId` of a configured provider is
 * required (`agent-model-required` / `agent-model-unavailable`).
 */
export type NewGroupAgentInput = CreateAgentInput & { templateId?: string };

/** `agents:create` payload: the agent joins `groupId` (its only group). */
export type CreateGroupAgentInput = NewGroupAgentInput & { groupId: string };

/**
 * `agents:generate-profile` (A3): one LLM call to `modelId` for a custom
 * agent's `{ role, instructions }`. The other members' roles of `groupId`
 * (minus `agentId`, when regenerating an existing agent) are sent so the new
 * role complements them. The create-group modal (A4) has no group yet: it
 * omits `groupId` and sends the roles already chosen in the modal as `roles`.
 */
export type GenerateAgentProfileInput = {
  groupId?: string;
  /** Roles already chosen for the group being created (A4), added to the group's. */
  roles?: string[];
  modelId: string;
  name: string;
  /** "What should it help with?" (optional, short). */
  description?: string;
  agentId?: string;
};

/** The generated profile; `generated: false` is the fallback (with `warning`). */
export type GeneratedAgentProfile = {
  role: string;
  instructions: string;
  generated: boolean;
  warning?: string;
};

/** `agents:update` payload: only the given fields change; null clears model / Project. */
export type UpdateAgentInput = Partial<CreateAgentInput>;

/** A group plus its member rows (what the sidebar and `group:*` IPC return). */
export type AgentGroupWithMembers = AgentGroupInfo & { members: AgentGroupMember[] };

/** The lead after a members change: a kept member (by agent id) or a new agent (by name). */
export type GroupLeadRef = { agentId: string } | { name: string };

/**
 * `group:update-members` ("Manage members"): ONE transaction, all or nothing.
 * The 2..10 rule and the lead are checked against the FINAL state.
 */
export type UpdateAgentGroupMembersInput = {
  groupId: string;
  /** NEW agents created in the group (the agent model rule applies to each). */
  add: NewGroupAgentInput[];
  /** Members removed; removing a member deletes its agent. */
  removeAgentIds: string[];
  /** The final lead (a kept member or one of `add`), or null for none. */
  lead: GroupLeadRef | null;
};

/** `group:create` payload: the group, its agents and lead agent, all at once. */
export type CreateAgentGroupInput = {
  name: string;
  /** Owning Project id: required (null / the Chats inbox fail with `group-project-required`). */
  workspaceId: string | null;
  mode?: AgentGroupMode;
  /** 2..10 NEW agents, created in the group (an agent belongs to one group). */
  members: NewGroupAgentInput[];
  /** The lead, by one of the members' names (case-insensitive). */
  leadName?: string | null;
};

export type GroupMessageAuthorKind = "user" | "agent" | "system";
export type GroupMessageKind = "message" | "status";

/** Image payload attached to a group user message (reuses PromptImageAttachment). */
export type GroupMessageAttachment = {
  type: "image";
  data: string;
  mimeType: string;
  name?: string | undefined;
};

/** File/folder context chip attached to a group user message. */
export type GroupMessageContextItem =
  | { type: "file"; path: string; range?: { fromLine?: number; toLine?: number } }
  | { type: "folder"; path: string };

export type GroupMessageStatus =
  | "queued"
  | "running"
  | "writing"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type GroupMessage = {
  id: string;
  groupId: string;
  authorKind: GroupMessageAuthorKind;
  authorSessionId?: string;
  replyToMessageId?: string;
  /** Directed message recipient; absent means addressed to the whole group. */
  toSessionId?: string;
  /**
   * Ask-spanning execution id (chain root). Shared by user + agent messages,
   * tasks, and decisions for one Nova tarefa / Complementar thread. Same value
   * as the opener message id when `startsChain` opened the chain.
   */
  chainId?: string;
  kind: GroupMessageKind;
  body: string;
  /** Mentioned member session ids. */
  mentions: string[];
  /** Image attachments preserved for transcript + wake prompts. */
  attachments?: GroupMessageAttachment[];
  /** Path-backed context items available to woken agents. */
  contextItems?: GroupMessageContextItem[];
  createdAt: string;
  /**
   * Per-member turn / job id (`group_jobs.id`). Distinct from `chainId`
   * (ask-spanning execution). Used by resume-by-id.
   */
  turnId?: string;
  runId?: string;
  sdkMessageId?: string;
  /** Server-assigned order. Updates never move a message in the conversation. */
  sequence?: number;
  status?: GroupMessageStatus;
  /** Monotonic revision timestamp for idempotent snapshot/live upserts. */
  updatedAt?: string;
  error?: string;
};

/** Message pagination cursor: the (createdAt, id) total order of group messages. */
export type GroupMessageCursor = { createdAt: string; id: string };

export type GroupTaskStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled";

export type GroupTask = {
  id: string;
  groupId: string;
  title: string;
  description?: string;
  status: GroupTaskStatus;
  ownerSessionId?: string;
  createdBySessionId?: string;
  reviewerSessionId?: string;
  /** Optional until the Group task store migration projects defaults for legacy rows. */
  kind?: GroupTaskKind;
  priority?: GroupTaskPriority;
  stage?: GroupTaskStage;
  blockedReason?: string;
  dependencyIds?: string[];
  criteria?: GroupTaskCriterion[];
  criteriaVersion?: number;
  verificationPolicy?: GroupTaskVerificationPolicy;
  evidenceRefs?: GroupTaskEvidenceRef[];
  review?: GroupTaskReview;
  stateVersion?: number;
  branch?: string;
  /**
   * Ask-spanning execution id (`GroupMessage.chainId`). Links the checklist
   * row to the same Nova tarefa / Complementar thread as room messages.
   */
  executionId?: string;
  createdAt: string;
  updatedAt: string;
};

/** Shared context of a group (PR 6): recorded by members, deleted only by the user. */
export type GroupDecision = {
  id: string;
  groupId: string;
  text: string;
  /** Absent when the author session was deleted (shown as a former member, never the user). */
  authorSessionId?: string;
  sourceMessageId?: string;
  /** Ask-spanning execution id (`GroupMessage.chainId`) when recorded inside a turn. */
  executionId?: string;
  createdAt: string;
};

/** Composer intent: open a new execution, or append to the active one. */
export type GroupExecutionMode = "new" | "complement";

export type PostGroupMessageInput = {
  groupId: string;
  body: string;
  /** Mentioned member session ids (in addition to `@Title` mentions parsed from the body). */
  mentions?: string[];
  replyToMessageId?: string;
  /** Image attachments forwarded to agents selected by Group Runtime. */
  attachments?: GroupMessageAttachment[];
  /** Path-backed context items forwarded with the wake prompt. */
  contextItems?: GroupMessageContextItem[];
  /**
   * `new` (default) opens a fresh execution (`startsChain`).
   * `complement` joins `executionId` or the group's latest user execution.
   */
  executionMode?: GroupExecutionMode;
  /** Explicit execution to complement; ignored when `executionMode` is `new`. */
  executionId?: string;
};

/**
 * Resume an interrupted/failed group turn by its durable execution id (job/turn id).
 * Requeues the existing job in the same chain — does not post a new user message.
 */
export type ResumeGroupExecutionInput = {
  groupId: string;
  /** Group job id / message `turnId`. */
  executionId: string;
};

/** Why a group chain stopped waking members (it waits for the user). */
export type GroupChainEndReason =
  | "blocked"
  /** The user pressed Stop in the room (running turns are aborted). */
  | "stopped"
  | "max-agent-messages"
  | "max-member-wakes"
  | "input-token-budget"
  | "context-too-large";

/**
 * Compact Project context status for Agent Groups Setup.
 * Persisted per workspace (shared map); shown per open group room.
 */
export type GroupProjectContextStatus =
  | "mapping"
  | "ready"
  | "updating"
  | "needs_refresh"
  | "failed";

/** Snapshot returned by `group:project-context` and pushed on `group.project-setup`. */
export type GroupProjectContextSnapshot = {
  workspaceId: string;
  status: GroupProjectContextStatus;
  /** Short SHA-256 hex of the project fingerprint (empty while first mapping). */
  fingerprint: string;
  /** CodeGraph index state when known (`created` | `synced` | `ready` | …). */
  codegraphState?: string;
  edgeCount: number;
  detail?: string;
  revision?: string;
  updatedAt: string;
  lastReadyAt?: string;
};

/**
 * `group:event` push (main → renderer) from the group runtime. `group.activity`
 * carries the runtime state the sidebar's activity dot reads.
 */
export type GroupRuntimeEvent =
  | { type: "group.message"; groupId: string; message: GroupMessage }
  | {
      type: "group.task-changed";
      groupId: string;
      taskId: string;
      stateVersion: number;
    }
  | {
      type: "group.activity";
      groupId: string;
      /** Members with a group turn running now. */
      runningSessionIds: string[];
      /** Members woken and waiting for a slot (or for the window/update/streaming gate). */
      queuedSessionIds: string[];
      /** Members waiting for the user (intent gate open, or a HyperPlan choice pending). */
      waitingSessionIds: string[];
    }
  | { type: "group.chain-ended"; groupId: string; chainId: string; reason: GroupChainEndReason }
  | {
      type: "group.project-setup";
      workspaceId: string;
      /** Present when Setup was tied to a specific group create / room. */
      groupId?: string;
      status: GroupProjectContextStatus;
      fingerprint: string;
      edgeCount: number;
      codegraphState?: string;
      detail?: string;
      updatedAt: string;
    };

/** One group's member states (`group:member-states` snapshot; same fields as `group.activity`). */
export type GroupMemberStates = {
  groupId: string;
  runningSessionIds: string[];
  queuedSessionIds: string[];
  waitingSessionIds: string[];
};
