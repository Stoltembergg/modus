import { describe, expect, it } from "vitest";
import {
  closeSettingsNavigation,
  INITIAL_PRIMARY_NAVIGATION,
  navigatePrimary,
  restorePrimaryNavigation,
} from "./navigation-state";

describe("primary navigation", () => {
  it("returns from Settings to the last primary destination", () => {
    const groups = navigatePrimary(INITIAL_PRIMARY_NAVIGATION, "settings");
    expect(groups).toEqual({ active: "settings", settingsReturnTo: "groups" });

    const directMessages = navigatePrimary(groups, "direct-messages");
    const settings = navigatePrimary(directMessages, "settings");
    expect(closeSettingsNavigation(settings)).toEqual({
      active: "direct-messages",
      settingsReturnTo: "direct-messages",
    });
  });

  it("opens Connections as a first-level destination without changing the settings return target", () => {
    const settings = navigatePrimary(INITIAL_PRIMARY_NAVIGATION, "settings");
    const connections = navigatePrimary(settings, "connections");
    expect(connections).toEqual({ active: "connections", settingsReturnTo: "groups" });
  });

  it("restores an active Direct Message before opening restored Settings", () => {
    expect(
      restorePrimaryNavigation(INITIAL_PRIMARY_NAVIGATION, {
        settingsOpen: false,
        activeSessionId: "session-1",
      }),
    ).toEqual({ active: "direct-messages", settingsReturnTo: "groups" });

    expect(
      restorePrimaryNavigation(INITIAL_PRIMARY_NAVIGATION, {
        settingsOpen: true,
        activeSessionId: "session-1",
      }),
    ).toEqual({ active: "settings", settingsReturnTo: "direct-messages" });
  });
});
