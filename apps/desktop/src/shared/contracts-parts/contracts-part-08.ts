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
  sessionId: string;
  /** Free-form role label, e.g. research / plan / implement / review / verify. */
  role?: string;
  joinedAt: string;
};

/** A group plus its member rows (what the sidebar and `group:*` IPC return). */
export type AgentGroupWithMembers = AgentGroupInfo & { members: AgentGroupMember[] };

/** `group:update-members` payload: the target member list and lead (all or nothing). */
export type UpdateAgentGroupMembersInput = {
  groupId: string;
  members: Array<{ sessionId: string; role?: string }>;
  /** Must be one of `members`, or null for no lead. */
  leadSessionId: string | null;
};

/** `group:create` payload: the group, its existing member sessions and lead, all at once. */
export type CreateAgentGroupInput = {
  name: string;
  /** Owning Project id; omit/null for a group with no Project (members from the Chats inbox). */
  workspaceId?: string | null;
  mode?: AgentGroupMode;
  members: Array<{ sessionId: string; role?: string }>;
  /** Must be one of `members`. */
  leadSessionId?: string | null;
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
  /** Absent when the user is the author (or the author session was deleted). */
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
