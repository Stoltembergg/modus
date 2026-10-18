// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { domMax, LazyMotion } from "motion/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { navRailMotion } from "../../lib/motion";
import { navRailRevealInitial } from "../ui/NavRail";
import { AppSidebar } from "./AppSidebar";

/*
 * The brand "Modus" text mounts only while the rail is expanded, so it needs
 * its own entrance (`NavRailReveal appear`). Item labels are always mounted and
 * fade via `animate`; they keep `initial={false}`. Nothing animates in on the
 * rail's first render (a rail pinned open at app start).
 */
const motionPrefs = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motionPrefs.reduced,
}));
vi.mock("../ui/ModusBot", () => ({ ModusBot: () => <span aria-hidden="true" /> }));
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
  window.localStorage.clear();
});

function sidebar(pinned: boolean) {
  return (
    <LazyMotion features={domMax} strict>
      <AppSidebar
        active="direct-messages"
        canCreateSession
        onNavigate={() => {}}
        onNewMessage={() => {}}
        onNewProfile={() => {}}
        onPinnedChange={() => {}}
        pinned={pinned}
      >
        <div>Chat list</div>
      </AppSidebar>
    </LazyMotion>
  );
}

const brandText = () => screen.queryByText("Modus", { selector: "span" }) as HTMLElement | null;
const itemLabels = () => Array.from(document.querySelectorAll<HTMLElement>(".nav-rail-item-label"));
const nav = () => screen.getByRole("navigation");

describe.each([
  ["full motion", false],
  ["reduced motion", true],
])("brand entrance (%s)", (_mode, reduced) => {
  it("does not animate in when the rail starts pinned open", () => {
    motionPrefs.reduced = reduced;
    render(sidebar(true));
    const text = brandText();
    expect(text).not.toBeNull();
    expect(text?.hasAttribute("data-appear")).toBe(false);
    expect(text?.style.opacity).not.toBe("0");
    for (const label of itemLabels()) {
      expect(label.hasAttribute("data-appear")).toBe(false);
      expect(label.style.opacity).not.toBe("0");
    }
  });

  it("fades in on a later expansion (collapse, then expand)", async () => {
    motionPrefs.reduced = reduced;
    const view = render(sidebar(true));
    view.rerender(sidebar(false));
    expect(nav().getAttribute("data-expanded")).toBe("false");
    expect(brandText()).toBeNull();

    fireEvent.mouseEnter(nav());
    expect(nav().getAttribute("data-expanded")).toBe("true");
    const text = brandText();
    expect(text?.hasAttribute("data-appear")).toBe(true);
    // Starts transparent; full motion also starts 4px to the left, reduced does not move.
    expect(text?.style.opacity).toBe("0");
    if (reduced) expect(text?.style.transform ?? "").not.toMatch(/translate/);
    else expect(text?.style.transform).toMatch(/translateX\(-4px\)/);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(brandText()?.style.opacity).toBe("1");
    // Item labels never get an entrance of their own.
    for (const label of itemLabels()) expect(label.hasAttribute("data-appear")).toBe(false);
  });
});

describe("navRailRevealInitial", () => {
  it("is false without appear (item labels) in both modes", () => {
    expect(navRailRevealInitial(navRailMotion(false), false)).toBe(false);
    expect(navRailRevealInitial(navRailMotion(true), false)).toBe(false);
  });

  it("fades and slides with full motion; opacity only with a 120ms fade when reduced", () => {
    expect(navRailRevealInitial(navRailMotion(false), true)).toEqual({ opacity: 0, x: -4 });
    const reduced = navRailMotion(true);
    expect(navRailRevealInitial(reduced, true)).toEqual({ opacity: 0 });
    expect(reduced.content).toMatchObject({ duration: 0.12 });
  });
});
