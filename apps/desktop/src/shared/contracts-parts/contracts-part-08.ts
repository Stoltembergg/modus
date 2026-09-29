/** Gap 4 contracts split part 8 — Agent Groups DTOs from #62 */
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

/** The 10 avatar colors (theme palette names; the renderer maps them to tokens). */
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
] as const;
export type AgentAvatarColor = (typeof AGENT_AVATAR_COLORS)[number];

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
};

/**
 * An agent created inside a group (`agents:create`, and each entry of
 * `group:create`). Without `templateId` a `modelId` of a configured provider is
 * required (`agent-model-required` / `agent-model-unavailable`).
 */
export type NewGroupAgentInput = CreateAgentInput & { templateId?: string };

/** `agents:create` payload: the agent joins `groupId` (its only group). */
export type CreateGroupAgentInput = NewGroupAgentInput & { groupId: string };

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

export type GroupMessage = {
  id: string;
  groupId: string;
  authorKind: GroupMessageAuthorKind;
  authorSessionId?: string;
  replyToMessageId?: string;
  /** Directed message recipient; absent means addressed to the whole group. */
  toSessionId?: string;
  /** The user message that opened this chain. */
  chainId?: string;
  kind: GroupMessageKind;
  body: string;
  /** Mentioned member session ids. */
  mentions: string[];
  createdAt: string;
};

/** Message pagination cursor: the (createdAt, id) total order of group messages. */
export type GroupMessageCursor = { createdAt: string; id: string };

export type GroupTaskStatus = "open" | "in_progress" | "in_review" | "done" | "cancelled";

export type GroupTask = {
  id: string;
  groupId: string;
  title: string;
  description?: string;
  status: GroupTaskStatus;
  ownerSessionId?: string;
  createdBySessionId?: string;
  reviewerSessionId?: string;
  branch?: string;
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
  createdAt: string;
};

export type PostGroupMessageInput = {
  groupId: string;
  body: string;
  /** Mentioned member session ids (in addition to `@Title` mentions parsed from the body). */
  mentions?: string[];
  replyToMessageId?: string;
};

/** Why a group chain stopped waking members (it waits for the user). */
export type GroupChainEndReason =
  | "blocked"
  /** The user pressed Stop in the room (running turns are aborted). */
  | "stopped"
  | "max-hops"
  | "max-agent-messages"
  | "max-member-wakes"
  | "input-token-budget"
  | "context-too-large";

/**
 * `group:event` push (main → renderer) from the group runtime. `group.activity`
 * carries the runtime state the sidebar's activity dot reads.
 */
export type GroupRuntimeEvent =
  | { type: "group.message"; groupId: string; message: GroupMessage }
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
  | { type: "group.chain-ended"; groupId: string; chainId: string; reason: GroupChainEndReason };

/** One group's member states (`group:member-states` snapshot; same fields as `group.activity`). */
export type GroupMemberStates = {
  groupId: string;
  runningSessionIds: string[];
  queuedSessionIds: string[];
  waitingSessionIds: string[];
};
