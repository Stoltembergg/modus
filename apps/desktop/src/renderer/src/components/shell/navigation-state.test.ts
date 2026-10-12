import { describe, expect, it } from "vitest";
import {
  closeSettingsNavigation,
  INITIAL_PRIMARY_NAVIGATION,
  navigatePrimary,
  restorePrimaryNavigation,
} from "./navigation-state";

describe("primary navigation", () => {
  it("opens on Projects", () => {
    expect(INITIAL_PRIMARY_NAVIGATION).toEqual({
      active: "direct-messages",
      settingsReturnTo: "direct-messages",
    });
  });

  it("returns from Settings to the last primary destination", () => {
    const projects = navigatePrimary(INITIAL_PRIMARY_NAVIGATION, "settings");
    expect(projects).toEqual({ active: "settings", settingsReturnTo: "direct-messages" });

    const groups = navigatePrimary(projects, "groups");
    const settings = navigatePrimary(groups, "settings");
    expect(closeSettingsNavigation(settings)).toEqual({
      active: "groups",
      settingsReturnTo: "groups",
    });
  });

  it("restores Projects with or without an active chat", () => {
    for (const activeSessionId of ["session-1", null, undefined]) {
      expect(
        restorePrimaryNavigation(INITIAL_PRIMARY_NAVIGATION, {
          settingsOpen: false,
          activeSessionId,
        }),
      ).toEqual({ active: "direct-messages", settingsReturnTo: "direct-messages" });
    }

    expect(
      restorePrimaryNavigation(INITIAL_PRIMARY_NAVIGATION, {
        settingsOpen: true,
        activeSessionId: null,
      }),
    ).toEqual({ active: "settings", settingsReturnTo: "direct-messages" });
  });
});
