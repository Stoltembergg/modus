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
  const preferredOwners = new Set<AgentAvatarShape>();
  const assignments = new Map<string, AgentAvatarShape>();

  // Reserve the first owner of each preferred shape before resolving collisions.
  // This keeps every later unique preference stable when an earlier member collides.
  for (const member of members) {
    if (preferredOwners.has(member.preferredShape)) continue;
    preferredOwners.add(member.preferredShape);
    used.add(member.preferredShape);
    assignments.set(member.agentId, member.preferredShape);
  }

  for (const member of members) {
    if (assignments.has(member.agentId)) continue;
    const shape = AGENT_AVATAR_SHAPES.find((candidate) => !used.has(candidate));
    if (!shape) {
      throw new RangeError(`No avatar shape remains for agent ${member.agentId}`);
    }
    used.add(shape);
    assignments.set(member.agentId, shape);
  }

  return new Map(
    members.map((member) => {
      const shape = assignments.get(member.agentId);
      if (!shape) {
        throw new RangeError(`No avatar shape was assigned to agent ${member.agentId}`);
      }
      return [member.agentId, shape];
    }),
  );
}
