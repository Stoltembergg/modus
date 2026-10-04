import type { GroupTaskKind } from "./group-work-state";

/** Intended work only. These values never grant tools or permissions. */
export const GROUP_CAPABILITY_IDS = [
  "plan",
  "implement",
  "verify",
  "review",
  "research",
  "docs",
] as const;
export const GROUP_SUPPORTED_TASK_KINDS = [
  "legacy",
  "code",
  "docs",
  "design",
  "review",
  "research",
  "question",
] as const satisfies readonly GroupTaskKind[];

export type GroupMemberCapabilities = {
  capabilityIds: string[];
  supportedTaskKinds: GroupTaskKind[];
};

/** Missing legacy fields stay empty; explicit values must be canonical. */
export function normalizeGroupMemberCapabilities(
  input: Partial<GroupMemberCapabilities> = {},
): GroupMemberCapabilities {
  function normalize<T extends string>(
    values: readonly T[] | undefined,
    allowed: readonly T[],
  ): T[] {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.some((value) => !allowed.includes(value))) {
      throw new Error("Invalid group member capabilities.");
    }
    return allowed.filter((value) => values.includes(value));
  }
  return {
    capabilityIds: normalize(input.capabilityIds, GROUP_CAPABILITY_IDS),
    supportedTaskKinds: normalize(input.supportedTaskKinds, GROUP_SUPPORTED_TASK_KINDS),
  };
}
