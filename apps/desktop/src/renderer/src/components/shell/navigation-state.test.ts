import { describe, expect, it } from "vitest";
import {
  closeSettingsNavigation,
  INITIAL_PRIMARY_NAVIGATION,
  isSessionConversationVisible,
  navigatePrimary,
  normalizePrimaryDestination,
  restorePrimaryNavigation,
} from "./navigation-state";

describe("primary navigation", () => {
  it("only treats a session as watched while its conversation pane is visible", () => {
    expect(isSessionConversationVisible("direct-messages", "session-1", "session-1")).toBe(true);
    expect(isSessionConversationVisible("settings", "session-1", "session-1")).toBe(false);
    expect(isSessionConversationVisible("automations", "session-1", "session-1")).toBe(false);
    expect(isSessionConversationVisible("direct-messages", "session-2", "session-1")).toBe(false);
  });

  it("opens on Projects", () => {
    expect(INITIAL_PRIMARY_NAVIGATION).toEqual({
      active: "direct-messages",
      settingsReturnTo: "direct-messages",
    });
  });

  it("returns from Settings to the last primary destination", () => {
    const projects = navigatePrimary(INITIAL_PRIMARY_NAVIGATION, "settings");
    expect(projects).toEqual({ active: "settings", settingsReturnTo: "direct-messages" });

    const back = navigatePrimary(projects, "direct-messages");
    const settings = navigatePrimary(back, "settings");
    expect(closeSettingsNavigation(settings)).toEqual({
      active: "direct-messages",
      settingsReturnTo: "direct-messages",
    });
  });

  it("returns from Settings to Automations when that was the last destination", () => {
    const automations = navigatePrimary(INITIAL_PRIMARY_NAVIGATION, "automations");
    const settings = navigatePrimary(automations, "settings");
    expect(closeSettingsNavigation(settings)).toEqual({
      active: "automations",
      settingsReturnTo: "automations",
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

  it("maps the retired Groups destination (and unknown values) to Projects", () => {
    expect(normalizePrimaryDestination("groups")).toBe("direct-messages");
    expect(normalizePrimaryDestination(undefined)).toBe("direct-messages");
    expect(normalizePrimaryDestination("settings")).toBe("settings");
    expect(normalizePrimaryDestination("automations")).toBe("automations");
  });
});
