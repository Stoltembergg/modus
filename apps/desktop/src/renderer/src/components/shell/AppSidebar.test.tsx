// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { domMax, LazyMotion } from "motion/react";
import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "../../features/settings/sections/SettingsSidebar";
import type { SettingsSectionId } from "../../features/settings/settings-types";
import {
  AppSidebar,
  appSidebarReservedWidth,
  readSidebarPinned,
  SIDEBAR_PINNED_KEY,
  writeSidebarPinned,
} from "./AppSidebar";

// Sidebar interactions do not depend on the mascot's asynchronous animation loop.
vi.mock("../ui/ModusBot", () => ({ ModusBot: () => <span aria-hidden="true" /> }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

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
  function SettingsNavigation() {
    const [slot, setSlot] = useState<HTMLDivElement | null>(null);
    const [section, setSection] = useState<SettingsSectionId>("general");
    return (
      <LazyMotion features={domMax} strict>
        <AppSidebar
          active="settings"
          canCreateSession
          onNavigate={() => {}}
          onNewMessage={() => {}}
          onPinnedChange={() => {}}
          pinned={false}
        >
          <div ref={setSlot} />
        </AppSidebar>
        <main>
          <button type="button">Settings content</button>
          {slot
            ? createPortal(
                <SettingsSidebar
                  activeSection={section}
                  embedded
                  onBack={() => {}}
                  onQueryChange={() => {}}
                  onSectionChange={setSection}
                  query=""
                />,
                slot,
              )
            : null}
        </main>
      </LazyMotion>
    );
  }

  it("keeps portal Settings navigation open when the pointer moves into its items", () => {
    render(<SettingsNavigation />);
    const nav = screen.getByRole("navigation");
    fireEvent.mouseEnter(nav);
    const settings = screen.getByRole("button", { name: "Settings" });
    const account = screen.getByRole("button", { name: "Account" });
    fireEvent.mouseOut(settings, { relatedTarget: account });
    fireEvent.mouseOver(account, { relatedTarget: settings });

    expect(screen.getByRole("button", { name: "Account" })).toBe(account);
    fireEvent.click(account);
    expect(account.getAttribute("aria-current")).toBe("page");
    fireEvent.focus(account);
    fireEvent.blur(account, {
      relatedTarget: screen.getByRole("button", { name: "Settings content" }),
    });
    expect(screen.getByRole("button", { name: "Account" })).toBe(account);
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe(
      "page",
    );

    fireEvent.mouseLeave(nav, {
      relatedTarget: screen.getByRole("button", { name: "Settings content" }),
    });
    expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
  });

  it("closes after keyboard focus leaves portal Settings navigation", () => {
    render(<SettingsNavigation />);
    fireEvent.focus(screen.getByRole("button", { name: "Settings" }));
    const account = screen.getByRole("button", { name: "Account" });
    fireEvent.focus(account);
    fireEvent.blur(account, {
      relatedTarget: screen.getByRole("button", { name: "Settings content" }),
    });
    expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
  });

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
    fireEvent.focus(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByTestId("context-sidebar")).toBeTruthy();
  });

  it("keeps Settings hover-expanded only while the pointer is over an unpinned sidebar", () => {
    renderSidebar({ active: "settings", pinned: false });
    const nav = screen.getByRole("navigation");
    const sidebar = document.querySelector(".app-animated-sidebar");

    expect(sidebar?.getAttribute("data-open")).toBe("false");
    fireEvent.mouseEnter(nav);
    expect(screen.getByTestId("context-sidebar")).toBeTruthy();
    fireEvent.mouseLeave(nav);

    expect(screen.queryByTestId("context-sidebar")).toBeNull();
    expect(sidebar?.getAttribute("data-open")).toBe("false");
  });

  it("keeps all destinations and actions as links", () => {
    const h = renderSidebar({ pinned: true });
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    expect(screen.queryByRole("button", { name: "Groups" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    expect(h.onNewMessage).toHaveBeenCalledOnce();
    expect(h.onNewProfile).toHaveBeenCalledOnce();
    expect(h.onNavigate.mock.calls).toEqual([["direct-messages"], ["settings"]]);
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

  it("defaults to the collapsed rail and remembers the user's pin choice", () => {
    window.localStorage.removeItem(SIDEBAR_PINNED_KEY);
    expect(readSidebarPinned()).toBe(false);
    writeSidebarPinned(true);
    expect(readSidebarPinned()).toBe(true);
    writeSidebarPinned(false);
    expect(readSidebarPinned()).toBe(false);
  });
});
