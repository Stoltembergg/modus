import { randomUUID } from "node:crypto";
import { agentAvatarForId } from "../../shared/agent-templates";
import type { AgentGroupWithMembers } from "../../shared/contracts";
import { getDatabase } from "../db/database";
import { createAgentGroup, getAgentGroupWithMembers } from "./group-store";

/**
 * TEST ONLY: a legacy group outside 2..10 (1 or 11+ members, from before the
 * rule). The stores refuse to build one, so the rows are written directly, the
 * way the A1/A2 migrations leave them: each session gets an agent in the group
 * named after its title, and turns `group_member`.
 */
export function insertLegacyGroup(input: {
  name: string;
  workspaceId: string;
  sessionIds: string[];
}): AgentGroupWithMembers {
  const group = createAgentGroup({ name: input.name, workspaceId: input.workspaceId });
  const db = getDatabase();
  for (const sessionId of input.sessionIds) {
    const row = db.prepare("select title from agent_sessions where id = ?").get(sessionId) as
      | { title: string }
      | undefined;
    const agentId = randomUUID();
    const { avatarFace, avatarColor, avatarShape } = agentAvatarForId(agentId);
    const now = new Date().toISOString();
    db.prepare(
      `insert into agents (id, group_id, name, avatar_face, avatar_color, avatar_shape, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(agentId, group.id, row?.title || "Agent", avatarFace, avatarColor, avatarShape, now, now);
    db.prepare(
      `insert into agent_group_members (group_id, session_id, role, joined_at, agent_id)
       values (?, ?, null, ?, ?)`,
    ).run(group.id, sessionId, now, agentId);
    db.prepare("update agent_sessions set kind = 'group_member' where id = ?").run(sessionId);
  }
  return getAgentGroupWithMembers(group.id);
}
