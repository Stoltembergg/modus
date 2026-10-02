import {
  AnimatePresence,
  MotionConfig,
  type MotionStyle,
  m,
  type Transition,
  useReducedMotion,
  type Variant,
} from "motion/react";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

type MorphingDialogContextValue = {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  uniqueId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
};

const MorphingDialogContext = createContext<MorphingDialogContextValue | null>(null);

function useMorphingDialog(): MorphingDialogContextValue {
  const context = useContext(MorphingDialogContext);
  if (!context) {
    throw new Error("MorphingDialog components must be used within MorphingDialog");
  }
  return context;
}

const DEFAULT_TRANSITION: Transition = {
  type: "spring",
  stiffness: 280,
  damping: 28,
  mass: 0.8,
};

export function MorphingDialog({
  children,
  transition = DEFAULT_TRANSITION,
  open,
  onOpenChange,
}: {
  children: ReactNode;
  transition?: Transition;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = open ?? uncontrolledOpen;
  const setIsOpen = useCallback(
    (next: boolean) => {
      onOpenChange?.(next);
      if (open === undefined) setUncontrolledOpen(next);
    },
    [onOpenChange, open],
  );
  const uniqueId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const reduceMotion = useReducedMotion();
  const value = useMemo(
    () => ({ isOpen, setIsOpen, uniqueId, triggerRef }),
    [isOpen, setIsOpen, uniqueId],
  );

  return (
    <MorphingDialogContext.Provider value={value}>
      <MotionConfig reducedMotion="user" transition={reduceMotion ? { duration: 0 } : transition}>
        {children}
      </MotionConfig>
    </MorphingDialogContext.Provider>
  );
}

export function MorphingDialogTrigger({
  children,
  className,
  style,
  "aria-label": ariaLabel,
  title,
}: {
  children: ReactNode;
  className?: string;
  style?: MotionStyle;
  "aria-label"?: string;
  title?: string;
}) {
  const { setIsOpen, isOpen, uniqueId, triggerRef } = useMorphingDialog();
  return (
    <m.button
      aria-controls={`morphing-dialog-content-${uniqueId}`}
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      aria-label={ariaLabel}
      className={cn("relative cursor-pointer", className)}
      layoutId={`dialog-${uniqueId}`}
      onClick={() => setIsOpen(!isOpen)}
      ref={triggerRef}
      title={title}
      {...(style !== undefined ? { style } : {})}
      type="button"
    >
      {children}
    </m.button>
  );
}

export function MorphingDialogContainer({ children }: { children: ReactNode }) {
  const { isOpen, uniqueId } = useMorphingDialog();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(
    <AnimatePresence initial={false} mode="sync">
      {isOpen ? (
        <div className="fixed inset-0 z-50" data-testid="morphing-dialog-root">
          <m.div
            animate={{ opacity: 1 }}
            className="dialog-scrim absolute inset-0"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            key={`backdrop-${uniqueId}`}
            onClick={(event) => {
              // Backdrop click is handled by content outside-click; keep visual only.
              event.preventDefault();
            }}
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <div className="pointer-events-auto">{children}</div>
          </div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

export function MorphingDialogContent({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: MotionStyle;
}) {
  const { setIsOpen, isOpen, uniqueId, triggerRef } = useMorphingDialog();
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setIsOpen]);

  useEffect(() => {
    if (!isOpen) {
      triggerRef.current?.focus();
      return;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = containerRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.[0]?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen, triggerRef]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current && !containerRef.current.contains(target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [isOpen, setIsOpen]);

  return (
    <m.div
      aria-labelledby={`morphing-dialog-title-${uniqueId}`}
      aria-modal="true"
      className={cn("overflow-hidden", className)}
      data-testid="morphing-dialog-content"
      id={`morphing-dialog-content-${uniqueId}`}
      layoutId={`dialog-${uniqueId}`}
      ref={containerRef}
      role="dialog"
      {...(style !== undefined ? { style } : {})}
    >
      {children}
    </m.div>
  );
}

export function MorphingDialogTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { uniqueId } = useMorphingDialog();
  return (
    <m.div className={className} id={`morphing-dialog-title-${uniqueId}`} layout>
      {children}
    </m.div>
  );
}

export function MorphingDialogClose({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
  variants?: { initial: Variant; animate: Variant; exit: Variant };
}) {
  const { setIsOpen } = useMorphingDialog();
  return (
    <button
      aria-label="Close"
      className={cn(
        "absolute top-3 right-3 flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg",
        className,
      )}
      onClick={() => setIsOpen(false)}
      type="button"
    >
      {children ?? <span aria-hidden="true">×</span>}
    </button>
  );
}
