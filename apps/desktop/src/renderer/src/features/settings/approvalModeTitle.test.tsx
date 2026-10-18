// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../../../../shared/contracts";
import { SETTINGS_TEXT_EN, SETTINGS_TEXT_PT } from "../../../../shared/settings-text";
import { ApprovalModeSettings } from "./ApprovalModeSettings";

const WORKSPACES = [
  { rootPath: "/work/landing-page", displayName: "landing-page" },
  { rootPath: "/work/api", displayName: "api" },
] as unknown as WorkspaceInfo[];

function fakePermission() {
  const state = { effective: "request-approval", global: "request-approval", project: null };
  const permission = {
    getMode: vi.fn(async () => state),
    setMode: vi.fn(async () => state),
    clearProjectMode: vi.fn(async () => state),
  };
  // biome-ignore lint/suspicious/noExplicitAny: partial preload bridge for the test
  (window as any).modus = { permission };
  return permission;
}

function sectionTitle(): string {
  return screen.getAllByRole("heading")[0]?.textContent ?? "";
}

beforeEach(() => {
  document.documentElement.lang = "en";
  fakePermission();
});
afterEach(() => {
  cleanup();
  // biome-ignore lint/suspicious/noExplicitAny: test cleanup
  delete (window as any).modus;
});

describe("ApprovalModeSettings title follows the selected scope", () => {
  it("shows the global title on the Home tab", async () => {
    await act(async () => {
      render(<ApprovalModeSettings cwd="/work/landing-page" workspaces={WORKSPACES} />);
    });
    expect(sectionTitle()).toBe("Global approval mode");
  });

  it("shows the project name on a project tab and goes back on Home", async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<ApprovalModeSettings cwd="/work/landing-page" workspaces={WORKSPACES} />);
    });
    await user.click(screen.getByRole("button", { name: "landing-page" }));
    expect(sectionTitle()).toBe("Approval mode · landing-page");
    expect(sectionTitle()).not.toMatch(/global/i);
    await user.click(screen.getByRole("button", { name: "api" }));
    expect(sectionTitle()).toBe("Approval mode · api");
    await user.click(screen.getByRole("button", { name: "Home" }));
    expect(sectionTitle()).toBe("Global approval mode");
  });

  it("has the scoped title and scope label in every locale", () => {
    expect(SETTINGS_TEXT_PT["settings.general.approvalModeProjectTitle"]).toBe(
      "Modo de aprovação · {project}",
    );
    expect(SETTINGS_TEXT_PT["settings.general.approvalScopeLabel"]).toBe(
      "Escopo do modo de aprovação",
    );
    expect(SETTINGS_TEXT_EN["settings.general.approvalModeProjectTitle"]).toBe(
      "Approval mode · {project}",
    );
  });

  it("does not label the scope tabs as global", async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<ApprovalModeSettings cwd="/work/landing-page" workspaces={WORKSPACES} />);
    });
    await user.click(screen.getByRole("button", { name: "landing-page" }));
    expect(screen.getByRole("group", { name: "Approval mode scope" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Global approval mode" })).toBeNull();
  });
});
