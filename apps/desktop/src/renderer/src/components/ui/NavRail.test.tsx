// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { domMax, LazyMotion } from "motion/react";
import { useState } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  NAV_RAIL_COMPACT_QUERY,
  NavRail,
  NavRailItem,
  navRailMotion,
  useHoldNavRail,
  useNavRail,
} from "./NavRail";

const motionPrefs = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motionPrefs.reduced,
}));
// Happy DOM's WAAPI differs from browsers; Motion falls back to its JS animator.
const nativeAnimation = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Reflect.deleteProperty(Element.prototype, "animate");
  return descriptor;
});
afterAll(() => {
  if (nativeAnimation) Object.defineProperty(Element.prototype, "animate", nativeAnimation);
});
afterEach(() => {
  cleanup();
  motionPrefs.reduced = false;
  Reflect.deleteProperty(window, "matchMedia");
});

function ExpandedProbe() {
  const { expanded } = useNavRail();
  return expanded ? <div data-testid="expanded-content">List</div> : null;
}

function HoldingMenu() {
  const [open, setOpen] = useState(false);
  useHoldNavRail(open);
  return (
    <button onClick={() => setOpen((value) => !value)} type="button">
      {open ? "Close row menu" : "Open row menu"}
    </button>
  );
}

function renderRail({ pinned = false, onSelect = vi.fn() } = {}) {
  render(
    <LazyMotion features={domMax} strict>
      <NavRail compactMenuLabel="Menu" label="Primary navigation" pinned={pinned}>
        <NavRailItem icon={<span />} label="New message" onSelect={onSelect} />
        <NavRailItem current icon={<span />} label="Settings" onSelect={() => {}} />
        <ExpandedProbe />
        <HoldingMenu />
      </NavRail>
      <button type="button">Main content</button>
    </LazyMotion>,
  );
  return { nav: screen.getByRole("navigation", { name: "Primary navigation" }), onSelect };
}

describe("NavRail", () => {
  it("expands while the pointer is over an unpinned rail and collapses when it leaves", () => {
    const { nav } = renderRail();
    expect(nav.getAttribute("data-expanded")).toBe("false");
    expect(nav.getAttribute("data-overlay")).toBe("false");
    expect(screen.queryByTestId("expanded-content")).toBeNull();
    fireEvent.mouseEnter(nav);
    expect(nav.getAttribute("data-expanded")).toBe("true");
    // Floating over main: the overlay state is what gets the blurred glass.
    expect(nav.getAttribute("data-overlay")).toBe("true");
    expect(nav.className).toContain("absolute");
    expect(screen.getByTestId("expanded-content")).toBeTruthy();
    fireEvent.mouseLeave(nav);
    expect(nav.getAttribute("data-expanded")).toBe("false");
    expect(screen.queryByTestId("expanded-content")).toBeNull();
  });

  it("stays expanded and in the layout when pinned", () => {
    const { nav } = renderRail({ pinned: true });
    expect(nav.getAttribute("data-expanded")).toBe("true");
    expect(nav.getAttribute("data-overlay")).toBe("false");
    expect(nav.className).not.toContain("absolute");
    fireEvent.mouseEnter(nav);
    fireEvent.mouseLeave(nav);
    expect(nav.getAttribute("data-expanded")).toBe("true");
  });

  it("expands for keyboard focus and collapses when focus leaves or on Escape", () => {
    const { nav } = renderRail();
    const item = screen.getByRole("button", { name: "New message" });
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focus(item);
    expect(nav.getAttribute("data-expanded")).toBe("true");
    // Moving between items keeps it open.
    const settings = screen.getByRole("button", { name: "Settings" });
    fireEvent.blur(item, { relatedTarget: settings });
    fireEvent.focus(settings);
    expect(nav.getAttribute("data-expanded")).toBe("true");
    fireEvent.blur(settings, {
      relatedTarget: screen.getByRole("button", { name: "Main content" }),
    });
    expect(nav.getAttribute("data-expanded")).toBe("false");

    fireEvent.focus(item);
    expect(nav.getAttribute("data-expanded")).toBe("true");
    fireEvent.keyDown(item, { key: "Escape" });
    expect(nav.getAttribute("data-expanded")).toBe("false");
  });

  it("does not stay open for focus left behind by a click once the pointer leaves", () => {
    const { nav, onSelect } = renderRail();
    const item = screen.getByRole("button", { name: "New message" });
    fireEvent.mouseEnter(nav);
    fireEvent.pointerDown(item);
    fireEvent.focus(item);
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
    fireEvent.mouseLeave(nav);
    expect(nav.getAttribute("data-expanded")).toBe("false");
  });

  it("keeps the rail expanded while a row menu holds it, then releases", () => {
    const { nav } = renderRail();
    fireEvent.mouseEnter(nav);
    fireEvent.click(screen.getByRole("button", { name: "Open row menu" }));
    // The pointer moves into the menu popup, which is portalled outside the rail.
    fireEvent.mouseLeave(nav);
    expect(nav.getAttribute("data-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close row menu" }));
    expect(nav.getAttribute("data-expanded")).toBe("false");
  });

  it("labels items for assistive tech and shows a tooltip only while collapsed", () => {
    const { nav } = renderRail();
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(settings.getAttribute("aria-current")).toBe("page");
    expect(
      screen.getByRole("button", { name: "New message" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(settings.getAttribute("title")).toBe("Settings");
    fireEvent.mouseEnter(nav);
    expect(settings.getAttribute("title")).toBeNull();
  });

  it("swaps slides for a short fade when the system asks for reduced motion", () => {
    const full = navRailMotion(false);
    const reduced = navRailMotion(true);
    expect(full.width).toMatchObject({ duration: 0.18 });
    expect(full.offsetX).toBeLessThan(0);
    // Reduced: the width snaps, nothing slides, but content still fades briefly.
    expect(reduced.width).toMatchObject({ duration: 0 });
    expect(reduced.offsetX).toBe(0);
    expect(reduced.content).toMatchObject({ duration: 0.12 });

    motionPrefs.reduced = true;
    const { nav } = renderRail();
    expect(nav.getAttribute("data-reduced-motion")).toBe("true");
    fireEvent.mouseEnter(nav);
    expect(nav.getAttribute("data-expanded")).toBe("true");
  });

  it("becomes a menu button with an overlay sheet on narrow viewports", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === NAV_RAIL_COMPACT_QUERY,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    const onSelect = vi.fn();
    render(
      <LazyMotion features={domMax} strict>
        <NavRail compactMenuLabel="Menu" label="Primary navigation" pinned={false}>
          <NavRailItem icon={<span />} label="New message" onSelect={onSelect} />
          <ExpandedProbe />
        </NavRail>
      </LazyMotion>,
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    const toggle = screen.getAllByRole("button", { name: "Menu" })[0] as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(nav.getAttribute("data-compact")).toBe("true");
    expect(nav.getAttribute("data-overlay")).toBe("true");
    expect(screen.getByTestId("expanded-content")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => {});
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
