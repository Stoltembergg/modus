import { describe, expect, it } from "vitest";
import type { AgentAvatarShape } from "./contracts";
import * as contracts from "./contracts";

type GroupMemberShapePreference = {
  agentId: string;
  preferredShape: AgentAvatarShape;
};
type ShapeAllocator = (
  members: readonly GroupMemberShapePreference[],
) => Map<string, AgentAvatarShape>;

function allocator(): ShapeAllocator {
  const candidate = (contracts as unknown as { allocateUniqueGroupAvatarShapes?: ShapeAllocator })
    .allocateUniqueGroupAvatarShapes;
  expect(candidate).toBeTypeOf("function");
  return candidate as ShapeAllocator;
}

describe("group avatar shape allocation", () => {
  it("keeps unique preferred shapes and falls back for collisions", () => {
    const allocate = allocator();
    const result = allocate([
      { agentId: "a", preferredShape: "hexagon" },
      { agentId: "b", preferredShape: "circle" },
      { agentId: "c", preferredShape: "hexagon" },
    ]);

    expect(result).toEqual(
      new Map([
        ["a", "hexagon"],
        ["b", "circle"],
        ["c", "squircle"],
      ]),
    );
  });

  it("assigns all ten silhouettes once in stable member order", () => {
    const allocate = allocator();
    const preferences: GroupMemberShapePreference[] = Array.from({ length: 10 }, (_, index) => ({
      agentId: `agent-${index + 1}`,
      preferredShape: "circle",
    }));

    const result = allocate(preferences);

    expect([...result.values()]).toEqual([
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
    ]);
  });

  it("rejects groups larger than the ten available shapes", () => {
    const allocate = allocator();
    const preferences: GroupMemberShapePreference[] = Array.from({ length: 11 }, (_, index) => ({
      agentId: `agent-${index + 1}`,
      preferredShape: "circle",
    }));

    expect(() => allocate(preferences)).toThrow();
  });

  it("makes a removed member's former shape available again", () => {
    const allocate = allocator();
    const remaining = allocate([
      { agentId: "a", preferredShape: "circle" },
      { agentId: "b", preferredShape: "circle" },
    ]);
    const afterRemoval = allocate([
      { agentId: "a", preferredShape: "circle" },
      { agentId: "c", preferredShape: "circle" },
    ]);

    expect(remaining.get("b")).toBe("squircle");
    expect(afterRemoval.get("c")).toBe("squircle");
  });
});
