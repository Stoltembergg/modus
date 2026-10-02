import { AGENT_AVATAR_SHAPES, type AgentAvatarShape } from "./contracts-parts/contracts-part-08";

export type GroupAvatarShapePreference = {
  agentId: string;
  preferredShape: AgentAvatarShape;
};

/** Keeps each preferred identity when free; resolves collisions in stable member order. */
export function allocateUniqueGroupAvatarShapes(
  members: readonly GroupAvatarShapePreference[],
): Map<string, AgentAvatarShape> {
  if (members.length > AGENT_AVATAR_SHAPES.length) {
    throw new RangeError(`A group can contain at most ${AGENT_AVATAR_SHAPES.length} agents`);
  }

  const used = new Set<AgentAvatarShape>();
  const assignments = new Map<string, AgentAvatarShape>();

  for (const member of members) {
    const shape = used.has(member.preferredShape)
      ? AGENT_AVATAR_SHAPES.find((candidate) => !used.has(candidate))
      : member.preferredShape;
    if (!shape) {
      throw new RangeError(`No avatar shape remains for agent ${member.agentId}`);
    }
    used.add(shape);
    assignments.set(member.agentId, shape);
  }

  return assignments;
}
