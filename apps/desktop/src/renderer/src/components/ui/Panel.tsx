import { m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** 面板小标题栏，右侧可放操作按钮（正常大小写、无分隔线、不加粗）。 */
export function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between px-3">
      <h2 className="text-sm font-normal text-fg-subtle">{title}</h2>
      {children}
    </div>
  );
}

/**
 * Shared empty hero for panels and inline lists.
 *
 * Full-bleed mode (default) is the Inspector/Git hero: icon in a soft backing,
 * hint, optional description and CTA. Pass `compact` for an inline list body
 * (Settings provider/model search) — same type scale and tones, tighter rhythm,
 * no icon backing. The single short fade+rise on mount reads as one deliberate
 * settle (list switches already animate via ContentTransition) rather than a
 * repeating flourish, and honours prefers-reduced-motion.
 *
 * Pass icons at size={22} stroke={1.4}.
 */
export function EmptyState({
  icon,
  hint,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: ReactNode;
  hint: string;
  description?: string;
  action?: ReactNode;
  className?: string | undefined;
  compact?: boolean;
}) {
  const reduce = useReducedMotion();
  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-1 px-5 py-10" : "h-full gap-3 px-6",
        className,
      )}
      initial={reduce ? false : { opacity: 0, y: compact ? 4 : 6 }}
      transition={{ duration: reduce ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      {icon ? (
        <span
          className={cn(
            "flex items-center justify-center text-fg-faint",
            compact ? "mb-1" : "size-10 rounded-lg bg-chip-faint",
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className={cn("text-fg-subtle", compact ? "text-sm" : "text-xs")}>{hint}</span>
      {description ? (
        <span className={cn("text-fg-muted text-xs", compact && "mx-auto mt-1 max-w-[300px]")}>
          {description}
        </span>
      ) : null}
      {action}
    </m.div>
  );
}
