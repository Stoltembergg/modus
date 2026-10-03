import { IconAlertTriangle, IconInfoCircle, IconLoader2, IconX } from "@tabler/icons-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import type { GroupSystemVariant } from "../../../../../shared/group-prompt-kit";
import { CollapsibleMotion } from "../../../components/ui/CollapsibleMotion";
import { cn } from "../../../lib/cn";
import { ICON, ICON_STROKE } from "../../../lib/uiDensity";
import { type GroupTextFn, useGroupText } from "../groupRoomI18n";

/** Message card with avatar and identity in the product surface palette. */
export function PromptMessage({
  children,
  className,
  ...props
}: {
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex max-w-[94%] gap-2.5 rounded-lg bg-card px-3 py-2.5 sm:max-w-[88%]",
        className,
      )}
      data-prompt-kit="message"
      {...props}
    >
      {children}
    </div>
  );
}

export function PromptMessageBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("min-w-0 flex-1 space-y-1.5", className)}>{children}</div>;
}

export function PromptMessageIdentity({
  name,
  role,
  trailing,
}: {
  name: ReactNode;
  role?: string | undefined;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 font-medium text-fg-muted text-xs">
      <span className="text-fg">{name}</span>
      {role?.trim() ? <span className="font-normal text-fg-faint">{role.trim()}</span> : null}
      {trailing}
    </div>
  );
}

/** Rare System Message (Prompt Kit) — blocks, approvals, important context. */
export function PromptSystemMessage({
  children,
  variant = "action",
  className,
  ...props
}: {
  children: ReactNode;
  variant?: GroupSystemVariant;
  className?: string | undefined;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  const Icon = variant === "error" || variant === "warning" ? IconAlertTriangle : IconInfoCircle;
  const tone =
    variant === "error"
      ? "border-danger/40 bg-danger/10 text-danger"
      : variant === "warning"
        ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
        : "border-hairline bg-elevated/80 text-fg-muted";
  return (
    <div
      className={cn(
        "mx-auto flex max-w-xl items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        tone,
        className,
      )}
      data-prompt-kit="system-message"
      data-variant={variant}
      role="status"
      {...props}
    >
      <Icon className="mt-0.5 shrink-0 opacity-80" size={ICON.sm} stroke={ICON_STROKE.sm} />
      <div className="min-w-0 flex-1 leading-snug">{children}</div>
    </div>
  );
}

/**
 * Prompt Kit Tool — compact ephemeral tool row (name + state).
 * Removed from the room as soon as the tool ends or streaming starts.
 */
export function PromptTool({
  name,
  state = "running",
  className,
}: {
  name: string;
  state?: "pending" | "running" | "completed" | "error";
  className?: string;
}) {
  const t = useGroupText();
  const badge =
    state === "completed"
      ? t("kit.completed")
      : state === "error"
        ? t("kit.error")
        : state === "pending"
          ? t("kit.ready")
          : t("kit.running");
  return (
    <div
      className={cn(
        "mt-0.5 flex max-w-full items-center gap-2 rounded-md border border-hairline bg-elevated/40 px-2 py-1 text-2xs text-fg-subtle",
        className,
      )}
      data-prompt-kit="tool"
      data-state={state}
      data-testid="group-prompt-tool"
    >
      {state === "running" || state === "pending" ? (
        <IconLoader2
          aria-hidden
          className="size-3 shrink-0 animate-spin text-fg-faint"
          stroke={ICON_STROKE.sm}
        />
      ) : null}
      <span className="min-w-0 truncate font-medium text-fg-muted">{name}</span>
      <span className="shrink-0 text-fg-faint">{badge}</span>
    </div>
  );
}

/** @deprecated Room no longer persists Steps — kept for Activity/tests. */
export function PromptSteps({
  title,
  items,
  defaultOpen = false,
}: {
  title?: string;
  items: readonly string[];
  defaultOpen?: boolean;
}) {
  const t = useGroupText();
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  return (
    <div className="mt-1" data-prompt-kit="steps" data-testid="group-prompt-steps">
      <button
        aria-expanded={open}
        className="flex items-center gap-1 text-2xs text-fg-faint hover:text-fg-muted"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="font-medium">{title ?? t("kit.steps")}</span>
        <span className="tabular-nums">({items.length})</span>
      </button>
      <CollapsibleMotion open={open} preset="compact">
        <ul className="relative mt-1 space-y-1 border-hairline border-l pl-3 text-2xs text-fg-subtle">
          {items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable step list
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      </CollapsibleMotion>
    </div>
  );
}

/** Collapsible safe progress summary using Prompt Kit's Chain of Thought visual. */
export function PromptChainOfThought({
  items,
  defaultOpen = false,
  title: titleProp,
  summary: summaryOverride,
}: {
  items: readonly string[];
  defaultOpen?: boolean;
  title?: string;
  summary?: string | undefined;
}) {
  const t = useGroupText();
  const title = titleProp ?? t("live.progress");
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  const summary = summaryOverride?.trim() || items[items.length - 1] || title;
  return (
    <div className="mt-1" data-prompt-kit="chain-of-thought" data-testid="group-prompt-cot">
      <button
        aria-expanded={open}
        className="flex max-w-full items-center gap-1 text-left text-2xs text-fg-faint hover:text-fg-muted"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="truncate font-medium">{open ? title : summary}</span>
      </button>
      <CollapsibleMotion open={open} preset="compact">
        <ol className="mt-1 space-y-1 pl-1 text-2xs text-fg-subtle">
          {items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable cot list
            <li className="flex gap-1.5" key={`${index}-${item}`}>
              <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-fg-faint" />
              <span>{item}</span>
            </li>
          ))}
        </ol>
      </CollapsibleMotion>
    </div>
  );
}

/** Compact attachment chip (Prompt Kit File Upload visual). */
export function AttachmentChip({
  name,
  mimeType,
  sizeLabel,
  previewUrl,
  error,
  onRemove,
}: {
  name: string;
  mimeType: string;
  sizeLabel?: string | undefined;
  previewUrl?: string | undefined;
  error?: string | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const t = useGroupText();
  const isImage = mimeType.startsWith("image/");
  return (
    <div
      className={cn(
        "group/chip relative flex max-w-[200px] items-center gap-2 rounded-lg border border-hairline bg-canvas px-2 py-1.5",
        error && "border-danger/50",
      )}
      data-testid="group-attachment-chip"
      title={error ?? name}
    >
      {isImage && previewUrl ? (
        <img
          alt=""
          className="size-8 shrink-0 rounded-md object-cover"
          draggable={false}
          src={previewUrl}
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated font-medium text-2xs text-fg-faint uppercase">
          {fileExt(name, mimeType)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-2xs text-fg">{name}</div>
        <div className="truncate text-[10px] text-fg-faint">
          {error ? error : [mimeTypeLabel(mimeType, t), sizeLabel].filter(Boolean).join(" · ")}
        </div>
      </div>
      {onRemove ? (
        <button
          aria-label={t("common.remove", { name })}
          className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-hairline bg-elevated text-fg-faint opacity-0 transition-opacity hover:text-fg group-hover/chip:opacity-100"
          onClick={onRemove}
          type="button"
        >
          <IconX size={10} stroke={2} />
        </button>
      ) : null}
    </div>
  );
}

function fileExt(name: string, mimeType: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  if (match?.[1]) return match[1].slice(0, 4);
  const subtype = mimeType.split("/")[1];
  return (subtype ?? "file").slice(0, 4);
}

function mimeTypeLabel(mimeType: string, t: GroupTextFn): string {
  if (mimeType.startsWith("image/")) return t("kit.image");
  if (mimeType.includes("pdf")) return "PDF";
  if (mimeType.includes("json")) return "JSON";
  if (mimeType.startsWith("text/")) return t("kit.text");
  return t("kit.file");
}

/**
 * Prompt Kit Text Shimmer — animated loading text for working agents above the composer.
 * https://www.prompt-kit.com/docs/text-shimmer
 *
 * Sheen via the shared `.t-think` / `.t-think-text` CSS (app.css) so packaging
 * does not depend on inline color-mix / custom keyframes.
 */
export function TextShimmer({
  children,
  duration = 4,
  spread: _spread = 20,
  className,
  ...props
}: {
  children: ReactNode;
  duration?: number;
  /** Accepted for Prompt Kit API compatibility; sheen width is CSS-fixed. */
  spread?: number;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "children" | "className">) {
  void _spread;
  const label = typeof children === "string" ? children : "";
  return (
    <span
      className={cn("t-think text-fg-subtle", className)}
      data-prompt-kit="text-shimmer"
      data-testid="group-text-shimmer"
      style={{ ["--think-shimmer" as string]: `${duration}s` } as CSSProperties}
      {...props}
    >
      {/* Invisible sizer — `.t-think-text` is absolute; without this the strip
          collapses to 0 height and paints under the composer below. */}
      <span aria-hidden="true" className="t-think-sizer">
        {children}
      </span>
      <span className="t-think-text" data-text={label}>
        {children}
      </span>
    </span>
  );
}
