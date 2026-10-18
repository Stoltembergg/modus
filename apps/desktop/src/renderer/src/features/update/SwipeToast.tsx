import { IconX } from "@tabler/icons-react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { MOTION_DURATION, reducedFade, tween } from "../../lib/motion";
import "./SwipeToast.css";

const FLICK = 0.11;
const DEAD_ZONE = 3;
const RESIST_PX = 24;
const COLLAPSE_MS = Math.round(MOTION_DURATION.slow * 1000);
const EXIT = 0.7;
const BURN = [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }];
const HAS_STARTING_STYLE = typeof window !== "undefined" && "CSSStartingStyleRule" in window;

export type SwipeToastCloseReason =
  | "timeout"
  | "swipe"
  | "action"
  | "close"
  | "escape"
  | "programmatic";

type SwipeToastProps = {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actionLabel?: ReactNode;
  onAction?: () => void;
  open?: boolean;
  onClose?: (reason: SwipeToastCloseReason) => void;
  background?: string;
  color?: string;
  fuseColor?: string;
  width?: number;
  radius?: number;
  slideMs?: number;
  settleBounce?: number;
  swipeDistance?: number;
  duration?: number;
  fuse?: "bottom" | "top" | "none";
  pauseOnHover?: boolean;
  closeButton?: boolean;
  closeLabel?: string;
  inline?: boolean;
  dismissible?: boolean;
  announce?: boolean;
  actionClassName?: string;
  actionId?: string;
  reduceMotionOverride?: boolean;
  "data-update-status"?: string;
  className?: string;
};

type Drag = {
  id: number;
  startY: number;
  grab: number | null;
  moved: boolean;
  history: Array<[number, number]>;
};

function rubberband(over: number, dimension: number, constant = 0.55): number {
  return (over * dimension * constant) / (dimension + constant * Math.abs(over));
}

function velocityOf(history: Array<[number, number]>): number {
  if (history.length < 2) return 0;
  const [startTime, startY] = history[0] ?? [0, 0];
  const [endTime, endY] = history.at(-1) ?? [0, 0];
  if (performance.now() - endTime > 100) return 0;
  return ((endY - startY) / Math.max(1, endTime - startTime)) * 1000;
}

/** Swipeable, timed toast presentation adapted from React Bits' SwipeToast. */
export function SwipeToast({
  title,
  description,
  icon,
  actionLabel,
  onAction,
  open = true,
  onClose,
  background = "#27272a",
  color = "#f5f5f5",
  fuseColor = "#f5a524",
  width = 356,
  radius = 12,
  slideMs = 400,
  settleBounce = 0.2,
  swipeDistance = 40,
  duration = 4000,
  fuse = "bottom",
  pauseOnHover = true,
  closeButton = false,
  closeLabel = "Close",
  inline = false,
  dismissible = true,
  announce = true,
  actionClassName = "",
  actionId,
  reduceMotionOverride,
  "data-update-status": updateStatus,
  className = "",
}: SwipeToastProps) {
  const systemReduceMotion = useReducedMotion();
  const reduceMotion = reduceMotionOverride ?? systemReduceMotion;
  const [phase, setPhase] = useState<"open" | "closing" | "gone">("open");
  const [instant, setInstant] = useState(false);
  const [mounted, setMounted] = useState(HAS_STARTING_STYLE);
  const cardRef = useRef<HTMLDivElement>(null);
  const fuseRef = useRef<HTMLElement>(null);
  const animation = useRef<Animation | null>(null);
  const drag = useRef<Drag | null>(null);
  const flags = useRef({ hover: false, interacting: false, focus: false, hidden: false });
  const lastInput = useRef<"pointer" | "keyboard">("pointer");
  const pendingClose = useRef<SwipeToastCloseReason | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaving = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const latest = useRef({ onClose, onAction, slideMs, inline });
  latest.current = { onClose, onAction, slideMs, inline };

  const y = useMotionValue(0);
  const fade = useMotionValue(1);
  const transform = useTransform(y, (value) => `translateY(${value}px)`);

  const syncFuse = useCallback((): void => {
    const current = animation.current;
    if (!current) return;
    const flagsNow = flags.current;
    if (flagsNow.hover || flagsNow.interacting || flagsNow.focus || flagsNow.hidden) {
      current.pause();
    } else if (current.playState === "paused") {
      void current.play();
    }
  }, []);

  const finish = useCallback((why: SwipeToastCloseReason): void => {
    setPhase("gone");
    leaving.current = false;
    if (latest.current.inline) {
      closeTimer.current = setTimeout(() => latest.current.onClose?.(why), COLLAPSE_MS);
    } else {
      latest.current.onClose?.(why);
    }
  }, []);

  const close = useCallback(
    (why: SwipeToastCloseReason): void => {
      if (phaseRef.current !== "open" || leaving.current) return;
      if (drag.current) {
        pendingClose.current = why;
        return;
      }
      animation.current?.pause();
      const immediate =
        why === "escape" ||
        ((why === "action" || why === "close") && lastInput.current === "keyboard");
      setInstant(immediate);
      setPhase("closing");
      clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(
        () => finish(why),
        immediate ? 0 : latest.current.slideMs * EXIT + 60,
      );
    },
    [finish],
  );

  const rescue = useCallback((): void => {
    clearTimeout(closeTimer.current);
    setInstant(false);
    y.set(0);
    fade.set(1);
    setPhase("open");
  }, [fade, y]);

  useEffect(() => {
    if (!open) close("programmatic");
    else if (phaseRef.current !== "open") rescue();
  }, [close, open, rescue]);

  useEffect(() => {
    if (HAS_STARTING_STYLE) return;
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (phase !== "open" || duration <= 0 || !fuseRef.current) return undefined;
    animation.current?.cancel();
    const current = fuseRef.current.animate(BURN, {
      duration,
      easing: "linear",
      fill: "forwards",
    });
    // Web Animations rejects `finished` when canceled; observe it to avoid an
    // unhandled rejection during state changes and unmount.
    void current.finished.catch(() => undefined);
    current.onfinish = () => close("timeout");
    animation.current = current;
    syncFuse();
    return () => {
      current.onfinish = null;
      current.pause();
    };
  }, [close, duration, phase, syncFuse]);

  useEffect(() => {
    if (pauseOnHover) return;
    flags.current.hover = false;
    syncFuse();
  }, [pauseOnHover, syncFuse]);

  useEffect(() => {
    const onVisibility = (): void => {
      flags.current.hidden = document.hidden;
      syncFuse();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(closeTimer.current);
      animation.current?.cancel();
    };
  }, [syncFuse]);

  const swipeOut = (distance: number, velocity: number): void => {
    animation.current?.pause();
    leaving.current = true;
    pendingClose.current = null;
    if (!reduceMotion && cardRef.current) {
      animate(y, distance + cardRef.current.offsetHeight, {
        type: "spring",
        duration: 0.3,
        bounce: 0,
        velocity,
      });
    }
    void animate(fade, 0, reduceMotion ? reducedFade : tween("slow")).then(() => finish("swipe"));
  };

  return (
    <div
      className={`swipe-toast${className ? ` ${className}` : ""}`}
      data-phase={phase}
      data-inline={inline ? "true" : "false"}
      data-fuse={duration > 0 ? fuse : "none"}
      data-dismissible={dismissible ? "true" : "false"}
      data-update-status={updateStatus}
      data-instant={instant ? "" : undefined}
      data-mounted={mounted ? "true" : "false"}
      style={
        {
          "--st-bg": background,
          "--st-ink": color,
          "--st-fuse": fuseColor,
          "--st-w": `${width}px`,
          "--st-radius": `${radius}px`,
          "--st-slide": `${slideMs}ms`,
          "--st-gap": "10px",
        } as CSSProperties
      }
    >
      <div className="swipe-toast__gate">
        <div className="swipe-toast__lift">
          <motion.div
            ref={cardRef}
            className="swipe-toast__card"
            role={announce ? "status" : "group"}
            aria-live={announce ? "polite" : "off"}
            aria-atomic={announce}
            tabIndex={0}
            style={{ transform: reduceMotion ? undefined : transform, opacity: fade }}
            onPointerDown={(event) => {
              lastInput.current = "pointer";
              if (
                event.button !== 0 ||
                !dismissible ||
                drag.current ||
                leaving.current ||
                (event.target instanceof Element && event.target.closest("button"))
              ) {
                return;
              }
              if (phaseRef.current === "closing") rescue();
              try {
                cardRef.current?.setPointerCapture(event.pointerId);
              } catch {
                // Pointer capture can be unavailable in synthetic DOMs.
              }
              y.stop();
              drag.current = {
                id: event.pointerId,
                startY: event.clientY,
                grab: null,
                moved: false,
                history: [[performance.now(), y.get()]],
              };
              flags.current.interacting = true;
              syncFuse();
            }}
            onPointerMove={(event) => {
              const current = drag.current;
              if (!current || current.id !== event.pointerId) return;
              if (current.grab === null) {
                if (Math.abs(event.clientY - current.startY) < DEAD_ZONE) return;
                current.grab = event.clientY - y.get();
                cardRef.current?.setAttribute("data-swiping", "");
              }
              const raw = event.clientY - current.grab;
              y.set(raw >= 0 ? raw : rubberband(raw, RESIST_PX));
              current.moved = true;
              current.history.push([performance.now(), y.get()]);
              if (current.history.length > 4) current.history.shift();
            }}
            onPointerUp={(event) => {
              const current = drag.current;
              if (!current || current.id !== event.pointerId) return;
              drag.current = null;
              cardRef.current?.removeAttribute("data-swiping");
              try {
                cardRef.current?.releasePointerCapture(event.pointerId);
              } catch {
                // Pointer capture may already have been released.
              }
              flags.current.interacting = false;
              const distance = y.get();
              const velocity = velocityOf(current.history);
              if (
                distance > 0 &&
                (velocity > FLICK || (distance >= swipeDistance && velocity >= 0))
              ) {
                swipeOut(distance, velocity);
                return;
              }
              if (current.moved) {
                animate(
                  y,
                  0,
                  reduceMotion
                    ? tween("slow")
                    : { type: "spring", duration: 0.5, bounce: settleBounce, velocity },
                );
              }
              const queued = pendingClose.current;
              pendingClose.current = null;
              if (queued) close(queued);
              else syncFuse();
            }}
            onPointerCancel={(event) => {
              const current = drag.current;
              if (!current || current.id !== event.pointerId) return;
              drag.current = null;
              cardRef.current?.removeAttribute("data-swiping");
              flags.current.interacting = false;
              y.set(0);
              const queued = pendingClose.current;
              pendingClose.current = null;
              if (queued) close(queued);
              else syncFuse();
            }}
            onPointerEnter={(event) => {
              if (pauseOnHover && event.pointerType === "mouse") {
                flags.current.hover = true;
                syncFuse();
              }
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") {
                flags.current.hover = false;
                syncFuse();
              }
            }}
            onFocus={() => {
              flags.current.focus = true;
              syncFuse();
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                flags.current.focus = false;
                syncFuse();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") lastInput.current = "keyboard";
              if (event.key === "Escape" && dismissible) {
                event.stopPropagation();
                close("escape");
              }
            }}
          >
            {icon ? (
              <span className="swipe-toast__icon" aria-hidden="true">
                {icon}
              </span>
            ) : null}
            <div className="swipe-toast__body">
              <div className="swipe-toast__title">{title}</div>
              {description ? <div className="swipe-toast__desc">{description}</div> : null}
            </div>
            {actionLabel ? (
              <button
                type="button"
                className={`swipe-toast__action${actionClassName ? ` ${actionClassName}` : ""}`}
                data-update-action={actionId}
                onClick={() => {
                  latest.current.onAction?.();
                  close("action");
                }}
              >
                {actionLabel}
              </button>
            ) : null}
            {closeButton ? (
              <button
                type="button"
                className="swipe-toast__close"
                aria-label={closeLabel}
                onClick={() => close("close")}
              >
                <IconX size={12} stroke={2.5} />
              </button>
            ) : null}
            <i ref={fuseRef} className="swipe-toast__fuse" aria-hidden="true" />
          </motion.div>
        </div>
      </div>
    </div>
  );
}
