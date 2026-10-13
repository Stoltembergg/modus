import { IconMenu2, IconX } from "@tabler/icons-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import {
  type ComponentProps,
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useState,
} from "react";
import { cn } from "../../lib/cn";

/**
 * Animated sidebar (Aceternity pattern), adapted for Modus:
 * - `m` instead of `motion` (the app runs LazyMotion strict),
 * - Tabler icons instead of lucide (the repo's icon set),
 * - buttons instead of next/link (no router; destinations are callbacks),
 * - `locked` keeps it open (pinned) so hover does not collapse it.
 */
export const SIDEBAR_COLLAPSED_WIDTH = 60;
export const SIDEBAR_EXPANDED_WIDTH = 300;
const WIDTH_TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const;

export type SidebarLinkItem = {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  href?: string;
};

type SidebarContextProps = {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  animate: boolean;
  locked: boolean;
};

const SidebarContext = createContext<SidebarContextProps | undefined>(undefined);

export function useSidebar(): SidebarContextProps {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
}

type ProviderProps = {
  children: ReactNode;
  open?: boolean;
  setOpen?: Dispatch<SetStateAction<boolean>>;
  animate?: boolean;
  locked?: boolean;
};

export function SidebarProvider({
  children,
  open: openProp,
  setOpen: setOpenProp,
  animate = true,
  locked = false,
}: ProviderProps) {
  const [openState, setOpenState] = useState(false);
  const open = locked || (openProp !== undefined ? openProp : openState);
  const setOpen = setOpenProp ?? setOpenState;
  return (
    <SidebarContext.Provider value={{ open, setOpen, animate, locked }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function Sidebar(props: ProviderProps) {
  return <SidebarProvider {...props} />;
}

type BodyProps = ComponentProps<typeof m.div> & { mobileLabel?: string };

const DESKTOP_QUERY = "(min-width: 768px)";

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () => typeof window.matchMedia !== "function" || window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const update = (): void => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return desktop;
}

/** One body at a time (desktop rail or mobile overlay), so content is never duplicated. */
export function SidebarBody({ mobileLabel, ...props }: BodyProps) {
  const desktop = useIsDesktop();
  if (desktop) return <DesktopSidebar {...props} />;
  return (
    <MobileSidebar
      className={typeof props.className === "string" ? props.className : undefined}
      label={mobileLabel}
    >
      {props.children as ReactNode}
    </MobileSidebar>
  );
}

/** A menu/popover opened from inside keeps the rail open until it closes. */
function hasOpenPopup(root: HTMLElement): boolean {
  return root.querySelector('[aria-expanded="true"], [data-popup-open]') !== null;
}

export function DesktopSidebar({ className, children, ...props }: ComponentProps<typeof m.div>) {
  const { open, setOpen, animate, locked } = useSidebar();
  const reduceMotion = useReducedMotion();
  const width = animate && !locked && !open ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH;
  return (
    <m.div
      animate={{ width }}
      className={cn("app-animated-sidebar flex h-full shrink-0 flex-col", className)}
      data-open={open ? "true" : "false"}
      initial={false}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next) && !hasOpenPopup(event.currentTarget)) {
          setOpen(false);
        }
      }}
      onFocus={() => setOpen(true)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!hasOpenPopup(event.currentTarget)) setOpen(false);
      }}
      transition={reduceMotion ? { duration: 0 } : WIDTH_TRANSITION}
      {...props}
    >
      {children}
    </m.div>
  );
}

export function MobileSidebar({
  className,
  children,
  label = "Menu",
}: {
  className?: string | undefined;
  children: ReactNode;
  label?: string | undefined;
}) {
  const { open, setOpen } = useSidebar();
  return (
    <div className="app-animated-sidebar-mobile flex h-10 w-full flex-row items-center justify-between px-4">
      <div className="z-20 flex w-full justify-end">
        <button
          aria-expanded={open}
          aria-label={label}
          className="app-sidebar-icon-button"
          onClick={() => setOpen(!open)}
          type="button"
        >
          <IconMenu2 aria-hidden size={20} />
        </button>
      </div>
      <AnimatePresence>
        {open ? (
          <m.div
            animate={{ x: 0, opacity: 1 }}
            className={cn(
              "app-animated-sidebar fixed inset-0 z-[100] flex h-full w-full flex-col justify-between p-4",
              className,
            )}
            exit={{ x: "-100%", opacity: 0 }}
            initial={{ x: "-100%", opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
          >
            <button
              aria-label="Close menu"
              className="app-sidebar-icon-button absolute top-4 right-4 z-50"
              onClick={() => setOpen(false)}
              type="button"
            >
              <IconX aria-hidden size={20} />
            </button>
            {children}
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function SidebarLink({
  link,
  active = false,
  disabled = false,
  className,
}: {
  link: SidebarLinkItem;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { open, animate, locked } = useSidebar();
  const showLabel = !animate || open || locked;
  return (
    <button
      aria-current={active ? "page" : undefined}
      aria-label={link.label}
      className={cn("app-sidebar-link group/sidebar", className)}
      data-active={active ? "true" : undefined}
      disabled={disabled}
      onClick={link.onClick}
      title={showLabel ? undefined : link.label}
      type="button"
    >
      <span aria-hidden className="app-sidebar-link-icon">
        {link.icon}
      </span>
      <m.span
        animate={{
          opacity: showLabel ? 1 : 0,
          display: showLabel ? "inline-block" : "none",
        }}
        className="app-sidebar-link-label"
        initial={false}
      >
        {link.label}
      </m.span>
    </button>
  );
}
