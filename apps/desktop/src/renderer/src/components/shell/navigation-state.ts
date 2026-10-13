export type PrimaryDestination = "direct-messages" | "settings";

/** Persisted/restored destinations: the retired "groups" (and anything unknown) → Projects. */
export function normalizePrimaryDestination(value: unknown): PrimaryDestination {
  return value === "settings" ? "settings" : "direct-messages";
}
export type WorkDestination = Exclude<PrimaryDestination, "settings">;

export type PrimaryNavigationState = {
  active: PrimaryDestination;
  settingsReturnTo: WorkDestination;
};

export const INITIAL_PRIMARY_NAVIGATION: PrimaryNavigationState = {
  active: "direct-messages",
  settingsReturnTo: "direct-messages",
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
  const primary = navigatePrimary(current, "direct-messages");
  return restored.settingsOpen ? navigatePrimary(primary, "settings") : primary;
}
