// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRail, type PrimaryDestination } from "./AppRail";
import { AppShell } from "./AppShell";
import { ContextSidebar } from "./ContextSidebar";
import { MainSurface } from "./MainSurface";
import { TopBar } from "./TopBar";

afterEach(cleanup);

describe("App shell", () => {
  it("keeps the rail, contextual sidebar, main surface, and optional activity in order", () => {
    render(
      <AppShell
        activity={<aside data-shell-layer="activity-inspector">Activity</aside>}
        main={
          <MainSurface>
            <TopBar>Room title</TopBar>
            <div>Room content</div>
          </MainSurface>
        }
        rail={<AppRail active="groups" onNavigate={vi.fn()} />}
        sidebar={<ContextSidebar>Group list</ContextSidebar>}
      />,
    );

    const shell = screen.getByTestId("app-shell");
    expect([
      shell.getAttribute("data-shell-layer"),
      ...Array.from(shell.querySelectorAll<HTMLElement>("[data-shell-layer]"), (element) =>
        element.getAttribute("data-shell-layer"),
      ),
    ]).toEqual([
      "app-shell",
      "app-rail",
      "context-sidebar",
      "main-surface",
      "top-bar",
      "activity-inspector",
    ]);
    expect(screen.getByText("Room content")).toBeTruthy();
  });

  it("labels the primary destinations and marks the active one", () => {
    const onNavigate = vi.fn<(destination: PrimaryDestination) => void>();
    render(
      <AppRail active="direct-messages" onNavigate={onNavigate} />,
    );

    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });
    const directMessages = within(navigation).getByRole("button", { name: "Direct Messages" });
    expect(directMessages.getAttribute("aria-current")).toBe("page");
    expect(within(navigation).getByRole("button", { name: "Groups" })).toBeTruthy();
    const connections = within(navigation).getByRole("button", { name: "Connections" });
    fireEvent.click(connections);
    expect(onNavigate).toHaveBeenCalledWith("connections");
    expect(within(navigation).getByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("reserves native titlebar space above the rail on macOS", () => {
    const { rerender } = render(
      <AppRail active="groups" nativeTitlebar onNavigate={vi.fn()} />,
    );

    const rail = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(rail.getAttribute("data-native-titlebar-clearance")).toBe("true");
    expect(rail.classList.contains("app-rail-native-titlebar")).toBe(true);

    rerender(<AppRail active="groups" onNavigate={vi.fn()} />);
    expect(
      screen
        .getByRole("navigation", { name: "Primary navigation" })
        .querySelector('[data-native-titlebar-clearance="true"]'),
    ).toBeNull();
  });
});
