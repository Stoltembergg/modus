// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
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

  it("exposes native glass state as shell metadata without elevating the main surface", () => {
    render(
      <AppShell
        glassMode="native"
        main={<MainSurface className="surface-main">Chat</MainSurface>}
      />,
    );

    const shell = screen.getByTestId("app-shell");
    expect(shell.getAttribute("data-glass-mode")).toBe("native");
    const main = shell.querySelector<HTMLElement>('[data-shell-layer="main-surface"]');
    expect(main?.classList.contains("surface-main")).toBe(true);
    expect(main?.classList.contains("surface-glass")).toBe(false);
  });

  it("labels the primary destinations and marks the active one", () => {
    const onNavigate = vi.fn<(destination: PrimaryDestination) => void>();
    render(<AppRail active="direct-messages" onNavigate={onNavigate} />);

    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });
    const directMessages = within(navigation).getByRole("button", { name: "Direct Messages" });
    expect(directMessages.getAttribute("aria-current")).toBe("page");
    expect(within(navigation).queryByText("Direct Messages")).toBeNull();
    expect(within(navigation).queryByText("Groups")).toBeNull();
    expect(within(navigation).getByRole("button", { name: "Groups" })).toBeTruthy();
    expect(within(navigation).queryByRole("button", { name: "Connections" })).toBeNull();
    const brand = within(navigation).getByTestId("app-rail-brand");
    const mascot = within(brand).getByRole("img", { name: "Modus" });
    expect(mascot.tagName.toLowerCase()).toBe("svg");
    expect(mascot.classList.contains("size-7")).toBe(true);
    expect(brand.querySelector("img")).toBeNull();
    expect(directMessages.getAttribute("title")).toBe("Direct Messages");
    const settings = within(navigation).getByRole("button", { name: "Settings" });
    expect(settings.getAttribute("title")).toBe("Settings");
    expect(within(navigation).queryByText("Settings")).toBeNull();
  });

  it("keeps rail destinations in fixed slots with larger vector icons across navigation", () => {
    const onNavigate = vi.fn<(destination: PrimaryDestination) => void>();
    const { rerender } = render(
      <AppRail active="groups" topChromeClearance onNavigate={onNavigate} />,
    );

    const metrics = () => {
      const navigation = screen.getByRole("navigation", { name: "Primary navigation" });
      return within(navigation)
        .getAllByRole("button")
        .map((button) => ({
          label: button.getAttribute("title"),
          iconSize: button.querySelector("svg")?.getAttribute("width"),
          slotClass: button.classList.contains("app-rail-item"),
        }));
    };

    const initialMetrics = metrics();
    expect(initialMetrics).toEqual([
      { label: "Groups", iconSize: "20", slotClass: true },
      { label: "Direct Messages", iconSize: "20", slotClass: true },
      { label: "Settings", iconSize: "20", slotClass: true },
    ]);

    rerender(<AppRail active="settings" topChromeClearance onNavigate={onNavigate} />);
    expect(metrics()).toEqual(initialMetrics);
  });

  it("reserves top chrome space above the rail when its row starts at the window top", () => {
    const { rerender } = render(
      <AppRail active="groups" topChromeClearance onNavigate={vi.fn()} />,
    );

    const rail = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(rail.getAttribute("data-top-chrome-clearance")).toBe("true");
    expect(rail.classList.contains("app-rail-top-chrome-clearance")).toBe(true);

    rerender(<AppRail active="groups" onNavigate={vi.fn()} />);
    expect(
      screen
        .getByRole("navigation", { name: "Primary navigation" })
        .querySelector('[data-top-chrome-clearance="true"]'),
    ).toBeNull();
  });
});
