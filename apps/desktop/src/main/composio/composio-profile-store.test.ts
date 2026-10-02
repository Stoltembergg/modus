import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createComposioProfileStore } from "./composio-profile-store";

describe("Composio profile store", () => {
  let userDataPath: string;
  const profilePath = () => join(userDataPath, "composio", "profile.json");

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "modus-composio-profile-"));
  });

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("creates and persists one opaque profile ID on first load", () => {
    const profile = createComposioProfileStore({ userDataPath }).load();

    expect(profile.version).toBe(1);
    expect(profile.profileId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(profile.toolkits).toEqual({});
    expect(existsSync(profilePath())).toBe(true);
    expect(createComposioProfileStore({ userDataPath }).load().profileId).toBe(profile.profileId);
  });

  it("preserves session, account aliases, and selected-tool policy across reloads", () => {
    const store = createComposioProfileStore({ userDataPath });
    const profile = store.load();
    const saved = {
      ...profile,
      sessionId: "session-123",
      toolkits: {
        github: {
          enabled: true,
          selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES", "GITHUB_GET_REPOSITORY"],
          selectedAccountId: "account-456",
          aliases: { "account-456": "Work GitHub" },
        },
      },
    };

    store.save(saved);

    expect(createComposioProfileStore({ userDataPath }).load()).toEqual(saved);
  });

  it("rejects malformed JSON instead of substituting an empty unrestricted profile", () => {
    mkdirSync(join(userDataPath, "composio"), { recursive: true });
    writeFileSync(profilePath(), "{not-json", "utf8");

    expect(() => createComposioProfileStore({ userDataPath }).load()).toThrow(/profile/i);
  });

  it("persists a separate For You selection alongside the legacy project policy", () => {
    const store = createComposioProfileStore({ userDataPath });
    const profile = store.load();
    const saved = {
      ...profile,
      forYou: { enabled: false, selectedToolSlugs: ["COMPOSIO_SEARCH_TOOLS"] },
    };
    store.save(saved);
    expect(createComposioProfileStore({ userDataPath }).load()).toEqual(saved);
  });

  it("rejects schema-invalid persisted policy instead of widening access", () => {
    mkdirSync(join(userDataPath, "composio"), { recursive: true });
    writeFileSync(
      profilePath(),
      JSON.stringify({
        version: 1,
        profileId: "b7ae3295-5e8c-4e35-8448-2ab7716b2650",
        toolkits: {
          github: {
            enabled: true,
            selectedToolSlugs: "all",
            aliases: {},
          },
        },
      }),
      "utf8",
    );

    expect(() => createComposioProfileStore({ userDataPath }).load()).toThrow(/profile/i);
  });

  it("preserves an explicit empty tool policy when updated", () => {
    const store = createComposioProfileStore({ userDataPath });
    const profile = store.load();

    store.update((current) => ({
      ...current,
      toolkits: {
        github: { enabled: false, selectedToolSlugs: [], aliases: {} },
      },
    }));

    const loaded = JSON.parse(readFileSync(profilePath(), "utf8")) as {
      toolkits: Record<string, { selectedToolSlugs: string[] }>;
    };
    expect(loaded.toolkits.github?.selectedToolSlugs).toEqual([]);
    expect(store.load().profileId).toBe(profile.profileId);
  });
});
