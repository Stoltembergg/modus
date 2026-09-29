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

export type GroupDecision = {
  id: string;
  groupId: string;
  text: string;
  sourceMessageId?: string;
  createdBySessionId?: string;
  supersededById?: string;
  createdAt: string;
};
