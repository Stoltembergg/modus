// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { domMax, LazyMotion } from "motion/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSidebar, appSidebarReservedWidth } from "./AppSidebar";

afterEach(cleanup);

function renderSidebar(props: Partial<Parameters<typeof AppSidebar>[0]> = {}, list?: ReactNode) {
  const handlers = {
    onNavigate: vi.fn(),
    onPinnedChange: vi.fn(),
    onNewMessage: vi.fn(),
    onNewProfile: vi.fn(),
  };
  render(
    <LazyMotion features={domMax} strict>
      <AppSidebar active="direct-messages" canCreateSession pinned={false} {...handlers} {...props}>
        {list ?? <div>Chat list</div>}
      </AppSidebar>
    </LazyMotion>,
  );
  return handlers;
}

describe("AppSidebar", () => {
  it("is one sidebar: no separate icon rail next to the context list", () => {
    renderSidebar({ pinned: true });
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(document.querySelector(".app-rail")).toBeNull();
    expect(screen.getByTestId("context-sidebar").textContent).toContain("Chat list");
  });

  it("reserves 300px pinned and 60px unpinned, so hover never reflows main", () => {
    expect(appSidebarReservedWidth(true)).toBe(300);
    expect(appSidebarReservedWidth(false)).toBe(60);
    renderSidebar({ pinned: false });
    expect(screen.getByTestId("app-sidebar").style.width).toBe("60px");
  });

  it("collapsed shows icons only and expands on hover or keyboard focus", () => {
    renderSidebar({ pinned: false });
    expect(screen.queryByTestId("context-sidebar")).toBeNull();
    const nav = screen.getByRole("navigation");
    fireEvent.mouseEnter(nav);
    expect(screen.getByTestId("context-sidebar")).toBeTruthy();
    fireEvent.mouseLeave(nav);
    expect(screen.queryByTestId("context-sidebar")).toBeNull();
    fireEvent.focus(screen.getByRole("button", { name: "Groups" }));
    expect(screen.getByTestId("context-sidebar")).toBeTruthy();
  });

  it("keeps all destinations and actions as links", () => {
    const h = renderSidebar({ pinned: true });
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    expect(h.onNewMessage).toHaveBeenCalledOnce();
    expect(h.onNewProfile).toHaveBeenCalledOnce();
    expect(h.onNavigate.mock.calls).toEqual([["groups"], ["settings"]]);
    expect(screen.getByRole("button", { name: "Projects" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("pin button toggles the pinned state", () => {
    const h = renderSidebar({ pinned: true });
    const unpin = screen.getByRole("button", { name: "Unpin sidebar" });
    expect(unpin.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(unpin);
    expect(h.onPinnedChange).toHaveBeenCalledWith(false);
  });

  it("disables New message when no model can start a chat", () => {
    renderSidebar({ pinned: true, canCreateSession: false });
    expect(
      (screen.getByRole("button", { name: "New message" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
