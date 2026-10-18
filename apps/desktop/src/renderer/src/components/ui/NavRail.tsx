import { IconMenu2 } from "@tabler/icons-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { type NavRailMotion, navRailMotion, reducedTarget } from "../../lib/motion";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";

/** Width of the icon-only rail. */
export const NAV_RAIL_COLLAPSED_WIDTH = 60;
/** Width of the rail while it shows labels and the contextual list. */
export const NAV_RAIL_EXPANDED_WIDTH = 300;
/** Below this viewport width the rail turns into a menu button + overlay sheet. */
export const NAV_RAIL_COMPACT_QUERY = "(max-width: 640px)";

/* Rail motion lives in lib/motion.ts (navRailMotion); re-exported for callers. */
export { type NavRailMotion, navRailMotion };

type NavRailState = {
  /** True while the rail shows labels and the contextual list. */
  expanded: boolean;
  pinned: boolean;
  /** Narrow viewport: the rail lives in an overlay sheet behind a menu button. */
  compact: boolean;
  motion: NavRailMotion;
  /** Collapse an unpinned rail now (e.g. after choosing a destination). */
  collapse(): void;
  /** Keep the rail expanded while `key` is held (open menus, drags). */
  hold(key: string, active: boolean): void;
};

const NavRailContext = createContext<NavRailState | null>(null);

/**
 * True once the rail's first render has committed. Content that mounts with the
 * rail on that first render (a rail pinned open at app start) must not animate
 * in; content that mounts on a later expansion may (`NavRailReveal appear`).
 * `null` outside a rail: nothing there animates in.
 */
const NavRailRenderedContext = createContext<{ readonly current: boolean } | null>(null);

/** Rail state for content rendered inside `<NavRail>`; a pinned, static rail elsewhere. */
export function useNavRail(): NavRailState {
  return useContext(NavRailContext) ?? STATIC_RAIL;
}

const STATIC_RAIL: NavRailState = {
  expanded: true,
  pinned: true,
  compact: false,
  motion: navRailMotion(false),
  collapse: () => {},
  hold: () => {},
};

let holdSeq = 0;

/**
 * Keep the surrounding rail expanded while `active` (for example while a menu
 * opened from a row is showing in a portal outside the rail). No-op outside a rail.
 */
export function useHoldNavRail(active: boolean): void {
  const rail = useContext(NavRailContext);
  const keyRef = useRef<string>("");
  if (!keyRef.current) {
    holdSeq += 1;
    keyRef.current = `hold-${holdSeq}`;
  }
  const hold = rail?.hold;
  useEffect(() => {
    if (!hold) return;
    const key = keyRef.current;
    hold(key, active);
    return () => hold(key, false);
  }, [hold, active]);
}

function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(
    () =>
      typeof window.matchMedia === "function" && window.matchMedia(NAV_RAIL_COMPACT_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(NAV_RAIL_COMPACT_QUERY);
    const sync = () => setCompact(list.matches);
    sync();
    list.addEventListener?.("change", sync);
    return () => list.removeEventListener?.("change", sync);
  }, []);
  return compact;
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  );
}

function pointerIsOver(element: HTMLElement): boolean {
  try {
    return element.matches(":hover");
  } catch {
    return false;
  }
}

export type NavRailProps = {
  /** Accessible name of the navigation landmark. */
  label: string;
  /** Pinned rails stay expanded and take their full width in the layout. */
  pinned: boolean;
  /** Accessible name of the menu button shown on narrow viewports. */
  compactMenuLabel: string;
  className?: string;
  children: ReactNode;
};

/**
 * Modus navigation rail: a 60px icon column that widens to 300px while the
 * pointer is over it, keyboard focus is inside it, a row menu is open, or a chat
 * is being dragged. Pinned keeps it wide. Narrow viewports get a menu button that
 * opens the same content in an overlay sheet.
 *
 * Expansion reasons are tracked separately (pointer / keyboard focus / holds), so
 * one ending never cancels another. Hover and focus use native listeners on the
 * landmark because portalled content (Settings navigation) is inside it in the
 * DOM but outside it in the React tree.
 */
export function NavRail({ label, pinned, compactMenuLabel, className, children }: NavRailProps) {
  const reduced = useReducedMotion() ?? false;
  const motion = useMemo(() => navRailMotion(reduced), [reduced]);
  const compact = useCompactViewport();
  const [navElement, setNavElement] = useState<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [holds, setHolds] = useState<ReadonlySet<string>>(() => new Set());
  const [sheetOpen, setSheetOpen] = useState(false);
  const lastInput = useRef<"keyboard" | "pointer">("keyboard");

  const hold = useCallback((key: string, active: boolean) => {
    setHolds((current) => {
      if (current.has(key) === active) return current;
      const next = new Set(current);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const collapse = useCallback(() => {
    setPointerInside(false);
    setKeyboardFocus(false);
    setSheetOpen(false);
  }, []);

  // Remember how the user last interacted: focus that follows a click should not
  // keep the rail open once the pointer leaves, focus from Tab should.
  useEffect(() => {
    const onKey = () => {
      lastInput.current = "keyboard";
    };
    const onPointer = () => {
      lastInput.current = "pointer";
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);

  useEffect(() => {
    const nav = navElement;
    if (!nav) return;
    const enter = () => setPointerInside(true);
    const leave = () => {
      setPointerInside(false);
      setKeyboardFocus(false);
    };
    const focusIn = () => {
      if (lastInput.current === "keyboard") setKeyboardFocus(true);
    };
    const focusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && nav.contains(next)) return;
      setKeyboardFocus(false);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isTextEntry(event.target)) return;
      setPointerInside(false);
      setKeyboardFocus(false);
      setSheetOpen(false);
    };
    // A chat dragged out of the rail must not collapse it under the pointer.
    const dragStart = () => hold("drag", true);
    nav.addEventListener("mouseenter", enter);
    nav.addEventListener("mouseleave", leave);
    nav.addEventListener("focusin", focusIn);
    nav.addEventListener("focusout", focusOut);
    nav.addEventListener("keydown", keyDown);
    nav.addEventListener("dragstart", dragStart);
    return () => {
      nav.removeEventListener("mouseenter", enter);
      nav.removeEventListener("mouseleave", leave);
      nav.removeEventListener("focusin", focusIn);
      nav.removeEventListener("focusout", focusOut);
      nav.removeEventListener("keydown", keyDown);
      nav.removeEventListener("dragstart", dragStart);
    };
  }, [navElement, hold]);

  const dragging = holds.has("drag");
  useEffect(() => {
    if (!dragging) return;
    // `dragend` never reaches a source row the drop replaced, so listen globally.
    const release = () => hold("drag", false);
    window.addEventListener("dragend", release, true);
    window.addEventListener("drop", release, true);
    return () => {
      window.removeEventListener("dragend", release, true);
      window.removeEventListener("drop", release, true);
    };
  }, [dragging, hold]);

  // When the last hold ends, trust where the pointer really is.
  const held = holds.size > 0;
  const wasHeld = useRef(false);
  useEffect(() => {
    if (wasHeld.current && !held && navElement) {
      setPointerInside(pointerIsOver(navElement));
    }
    wasHeld.current = held;
  }, [held, navElement]);

  useEffect(() => {
    if (!compact) setSheetOpen(false);
  }, [compact]);

  // Sheet: move focus in when it opens, close on Escape anywhere, hand focus back.
  useEffect(() => {
    if (!compact || !sheetOpen) return;
    navElement?.querySelector<HTMLElement>("button:not(:disabled), [href]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      menuButtonRef.current?.focus();
    };
  }, [compact, sheetOpen, navElement]);

  const expanded = compact ? sheetOpen : pinned || pointerInside || keyboardFocus || held;
  const overlay = compact ? sheetOpen : !pinned && expanded;

  const state = useMemo<NavRailState>(
    () => ({ expanded, pinned, compact, motion, collapse, hold }),
    [expanded, pinned, compact, motion, collapse, hold],
  );

  const rendered = useRef(false);
  useEffect(() => {
    rendered.current = true;
  }, []);

  const nav = (
    <m.nav
      animate={{
        width: compact
          ? NAV_RAIL_EXPANDED_WIDTH
          : expanded
            ? NAV_RAIL_EXPANDED_WIDTH
            : NAV_RAIL_COLLAPSED_WIDTH,
      }}
      aria-label={label}
      className={cn(
        "nav-rail app-context-sidebar flex h-full flex-col",
        // Unpinned desktop rail floats over main, so widening never reflows it.
        !compact && !pinned && "absolute inset-y-0 left-0 z-40",
        className,
      )}
      data-compact={compact ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
      data-overlay={overlay ? "true" : "false"}
      data-pinned={pinned ? "true" : "false"}
      data-reduced-motion={reduced ? "true" : "false"}
      initial={false}
      ref={setNavElement}
      transition={motion.width}
    >
      <NavRailRenderedContext.Provider value={rendered}>{children}</NavRailRenderedContext.Provider>
    </m.nav>
  );

  if (!compact) {
    return <NavRailContext.Provider value={state}>{nav}</NavRailContext.Provider>;
  }

  return (
    <NavRailContext.Provider value={state}>
      <div className="nav-rail-compact flex h-full w-full flex-col items-center pt-3">
        <button
          aria-expanded={sheetOpen}
          aria-label={compactMenuLabel}
          className="nav-rail-icon-button"
          onClick={() => setSheetOpen((open) => !open)}
          ref={menuButtonRef}
          type="button"
        >
          <IconMenu2 aria-hidden size={ICON.rail} stroke={ICON_STROKE.rail} />
        </button>
      </div>
      <AnimatePresence>
        {sheetOpen ? (
          <m.div
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-50 flex"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            key="nav-rail-sheet"
            transition={motion.content}
          >
            <button
              aria-label={compactMenuLabel}
              className="dialog-scrim absolute inset-0"
              onClick={() => setSheetOpen(false)}
              tabIndex={-1}
              type="button"
            />
            <m.div
              animate={{ x: 0 }}
              className="relative h-full max-w-[85vw]"
              exit={{ x: motion.sheetOffsetX }}
              initial={{ x: motion.sheetOffsetX }}
              transition={motion.content}
            >
              {nav}
            </m.div>
          </m.div>
        ) : null}
      </AnimatePresence>
    </NavRailContext.Provider>
  );
}

export type NavRailItemProps = {
  icon: ReactNode;
  label: string;
  onSelect(): void;
  /** Marks the destination the user is on (aria-current="page"). */
  current?: boolean;
  disabled?: boolean;
};

/** One destination or action in the rail: icon always visible, label while expanded. */
export function NavRailItem({
  icon,
  label,
  onSelect,
  current = false,
  disabled = false,
}: NavRailItemProps) {
  const { expanded, compact, collapse, motion } = useNavRail();
  return (
    <button
      aria-current={current ? "page" : undefined}
      aria-label={label}
      className="nav-rail-item"
      data-current={current ? "true" : "false"}
      disabled={disabled}
      onClick={() => {
        onSelect();
        if (compact) collapse();
      }}
      title={expanded ? undefined : label}
      type="button"
    >
      <span aria-hidden className="nav-rail-item-icon">
        {icon}
      </span>
      <NavRailReveal className="nav-rail-item-label" motion={motion} visible={expanded}>
        {label}
      </NavRailReveal>
    </button>
  );
}

/**
 * Entrance for a `NavRailReveal` that mounts already visible: none on the
 * rail's first render, otherwise a fade (+ a few px slide with full motion;
 * opacity only under reduced motion, with `motion.content` = `reducedFade`).
 */
export function navRailRevealInitial(
  motion: NavRailMotion,
  appear: boolean,
): false | { opacity: number; x?: number } {
  if (!appear) return false;
  return reducedTarget({ opacity: 0, x: motion.offsetX }, motion.reduced);
}

/** Content that fades (and, with full motion, slides a few px) in with the expanded rail. */
export function NavRailReveal({
  visible,
  motion,
  appear = false,
  className,
  children,
}: {
  visible: boolean;
  motion: NavRailMotion;
  /**
   * Animate in when mounted already visible (content rendered only while the
   * rail is expanded, like the brand). Never on the rail's first render.
   */
  appear?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const rendered = useContext(NavRailRenderedContext);
  // Decided once at mount: later re-renders must not restart the entrance.
  const [entrance] = useState(() => appear && rendered?.current === true);
  return (
    <m.span
      animate={visible ? { opacity: 1, x: 0 } : { opacity: 0, x: motion.offsetX }}
      aria-hidden
      className={className}
      data-appear={entrance ? "" : undefined}
      initial={navRailRevealInitial(motion, entrance)}
      transition={motion.content}
    >
      {children}
    </m.span>
  );
}
