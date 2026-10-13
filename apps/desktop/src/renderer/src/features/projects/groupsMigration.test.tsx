// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGroupDrafts, GroupsMovedNotice, MigratedTranscript } from "./groupsMigration";

const NOTICE = {
  migrated: true,
  show: true,
  groups: [{ groupId: "g1", sessionId: "s1", title: "Alpha (group room)", workspaceId: "ws" }],
  backup: "/data/backups/modus-x-pre-groups.db",
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("groups moved notice", () => {
  it("shows once with the room chats and the backup; dismiss persists", async () => {
    window.localStorage.setItem("modus.group.composerDraft.v1.g1", "draft");
    window.localStorage.setItem("other", "keep");
    const api = { notice: vi.fn(async () => NOTICE), dismissNotice: vi.fn(async () => undefined) };
    const onOpenSession = vi.fn();
    render(<GroupsMovedNotice api={api} onOpenSession={onOpenSession} />);
    expect(await screen.findByText("Your groups moved to Projects")).toBeTruthy();
    expect(screen.getByText(/pre-groups\.db/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Alpha (group room)" }));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
    expect(window.localStorage.getItem("modus.group.composerDraft.v1.g1")).toBeNull();
    expect(window.localStorage.getItem("other")).toBe("keep");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(api.dismissNotice).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("groups-moved-notice")).toBeNull();
  });

  it("renders nothing when there is nothing to tell, but still clears drafts after migration", async () => {
    window.localStorage.setItem("modus.group.composerDraft.v1.g2", "x");
    const api = {
      notice: vi.fn(async () => ({ ...NOTICE, show: false, groups: [] })),
      dismissNotice: vi.fn(),
    };
    render(<GroupsMovedNotice api={api} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(api.notice).toHaveBeenCalled());
    await waitFor(() =>
      expect(window.localStorage.getItem("modus.group.composerDraft.v1.g2")).toBeNull(),
    );
    expect(screen.queryByTestId("groups-moved-notice")).toBeNull();
  });

  it("clearGroupDrafts removes only room drafts", () => {
    window.localStorage.setItem("modus.group.composerDraft.v1.a", "1");
    window.localStorage.setItem("modus.group.composerDraft.v1.b", "2");
    window.localStorage.setItem("modus.chat.draft", "3");
    expect(clearGroupDrafts(window.localStorage)).toBe(2);
    expect(window.localStorage.length).toBe(1);
  });

  it("the migrated room transcript renders read-only Markdown", () => {
    render(<MigratedTranscript body={"# Alpha (group room)\n\n**You** · now\n\nShip it"} />);
    expect(screen.getByTestId("migrated-transcript").textContent).toContain("Ship it");
    expect(screen.getByText("Group room history (read-only)")).toBeTruthy();
  });
});

describe("no Groups UI left", () => {
  // features/groups, components/sidebar-groups and SidebarGroups.tsx stay on disk
  // until PR 8 deletes them, but nothing in the app may import or call them.
  const root = join(__dirname, "../..");
  const retired = (rel: string) =>
    rel.startsWith("features/groups/") ||
    rel.startsWith("components/sidebar-groups/") ||
    rel.startsWith("components/SidebarGroups");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(root);

  it("no live renderer file imports the Groups UI or calls window.modus.group", () => {
    const offenders = files
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .filter((rel) => !retired(rel))
      .filter((rel) =>
        /features\/groups|sidebar-groups|SidebarGroups|window\.modus\.group\b/.test(
          readFileSync(join(root, rel), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("the rail has no Groups destination", () => {
    const rail = readFileSync(join(root, "components/shell/AppRail.tsx"), "utf8");
    expect(rail).not.toMatch(/"groups"|Groups/);
  });
});
