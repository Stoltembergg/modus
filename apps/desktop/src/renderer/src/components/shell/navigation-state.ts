export type PrimaryDestination = "groups" | "direct-messages" | "settings";
export type WorkDestination = Exclude<PrimaryDestination, "settings">;

export type PrimaryNavigationState = {
  active: PrimaryDestination;
  settingsReturnTo: WorkDestination;
};

export const INITIAL_PRIMARY_NAVIGATION: PrimaryNavigationState = {
  active: "groups",
  settingsReturnTo: "groups",
};

export function navigatePrimary(
  current: PrimaryNavigationState,
  destination: PrimaryDestination,
): PrimaryNavigationState {
  if (destination === "settings") {
    return {
      active: "settings",
      settingsReturnTo: current.active === "settings" ? current.settingsReturnTo : current.active,
    };
  }
  return { ...current, active: destination };
}

export function closeSettingsNavigation(current: PrimaryNavigationState): PrimaryNavigationState {
  if (current.active !== "settings") return current;
  return { active: current.settingsReturnTo, settingsReturnTo: current.settingsReturnTo };
}

export function restorePrimaryNavigation(
  current: PrimaryNavigationState,
  restored: { settingsOpen: boolean; activeSessionId?: string | null | undefined },
): PrimaryNavigationState {
  const primary = navigatePrimary(current, restored.activeSessionId ? "direct-messages" : "groups");
  return restored.settingsOpen ? navigatePrimary(primary, "settings") : primary;
}
