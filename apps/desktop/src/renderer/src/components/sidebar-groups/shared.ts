import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import type { NewGroupServices } from "../../features/groups/NewGroupModal";

export const SB_RAIL = "pointer-events-none flex w-5 shrink-0 items-center justify-center";
export const SB_ROW =
  "flex h-[30px] w-full items-center gap-2 rounded-md pr-1 pl-2 text-xs font-normal transition-colors";
export const SB_NEST = "pl-5";
export const SB_ICON = ICON.lg;
export const SB_STROKE = ICON_STROKE.lg;
export const SB_ACTION = ICON.sm;
export const SB_ACTION_STROKE = ICON_STROKE.sm;

/** Without app services the create-group modal cannot open (tests that omit them). */
export const NO_NEW_GROUP_SERVICES: NewGroupServices = {
  listAgents: async () => [],
  addFolder: async () => null,
  generateProfile: async () => {
    throw new Error("Profile generation is not available here.");
  },
};
