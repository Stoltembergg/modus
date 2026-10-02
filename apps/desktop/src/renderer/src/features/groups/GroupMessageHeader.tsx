/**
 * Room message header and delivery footer.
 *
 * Inspired by the ReUI "Message With Header and Delivery Status" pattern
 * (header `name · time` with a decorative dot, footer status line). This is a
 * rewrite on Modus tokens, not a copy: the footer only shows real room states
 * (see `groupDelivery.ts`) and never a "read" receipt.
 */
import {
  IconAlertTriangle,
  IconBan,
  IconCheck,
  IconClock,
  IconLoader2,
  IconMessageCheck,
  IconMessageOff,
  IconUserQuestion,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { formatClock } from "../../lib/formatClock";
import { ICON_STROKE } from "../../lib/uiDensity";
import { type GroupDelivery, type GroupDeliveryState, groupDeliveryLabel } from "./groupDelivery";
import type { MemberLabel } from "./memberLabels";

export function GroupMessageHeader({
  avatar,
  name,
  memberRole,
  createdAt,
  trailing,
}: {
  /** Small avatar (16px AgentAvatar or the user badge). */
  avatar?: ReactNode;
  name: ReactNode;
  /** Discreet role after the name (agent role or "Human"). */
  memberRole?: string | undefined;
  createdAt: string;
  trailing?: ReactNode;
}) {
  const ms = Date.parse(createdAt);
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs"
      data-testid="group-message-header"
    >
      {avatar}
      <span className="font-medium text-fg">{name}</span>
      {memberRole?.trim() ? <span className="text-fg-faint">{memberRole.trim()}</span> : null}
      <span aria-hidden className="text-fg-faint" data-testid="group-message-header-dot">
        ·
      </span>
      <time
        className="text-2xs text-fg-faint tabular-nums"
        dateTime={createdAt}
        title={Number.isNaN(ms) ? undefined : new Date(ms).toLocaleString()}
      >
        {formatClock(ms)}
      </time>
      {trailing}
    </div>
  );
}

const DELIVERY_ICON = {
  waiting: IconUserQuestion,
  working: IconLoader2,
  queued: IconClock,
  delivered: IconCheck,
  failed: IconAlertTriangle,
  cancelled: IconBan,
  noReply: IconMessageOff,
  answered: IconMessageCheck,
} satisfies Record<GroupDeliveryState, unknown>;

/** Same tones as the member card: amber for "waiting for you", danger for failures. */
function deliveryTone(state: GroupDeliveryState): string {
  if (state === "waiting") return "text-amber-400";
  if (state === "failed") return "text-danger";
  if (state === "working") return "text-fg-muted";
  return "text-fg-faint";
}

function memberTitle(sessionId: string, labels: ReadonlyMap<string, MemberLabel>): string {
  return labels.get(sessionId)?.title ?? sessionId;
}

/** "Planner" / "Planner, Builder" / "Planner, Builder +2". */
function namesSummary(names: readonly string[]): string {
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

export function GroupDeliveryFooter({
  delivery,
  labels,
  align,
  locale,
}: {
  delivery: GroupDelivery;
  labels: ReadonlyMap<string, MemberLabel>;
  align: "start" | "end";
  locale?: string | null;
}) {
  const { state, members } = delivery;
  const Icon = DELIVERY_ICON[state];
  const label = groupDeliveryLabel(state, locale);
  const names = members
    .filter((member) => member.state === state)
    .map((member) => memberTitle(member.sessionId, labels));
  const detail = members
    .map(
      (member) =>
        `${memberTitle(member.sessionId, labels)}: ${groupDeliveryLabel(member.state, locale)}`,
    )
    .join(" · ");
  return (
    <div
      className={cn(
        "flex max-w-full items-center gap-1 text-2xs",
        align === "end" ? "mr-3 self-end" : "ml-3 self-start",
        deliveryTone(state),
      )}
      data-delivery={state}
      data-testid="group-delivery-status"
      title={detail || undefined}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3 shrink-0",
          state === "working" && "animate-spin motion-reduce:animate-none",
        )}
        stroke={ICON_STROKE.sm}
      />
      <span>{label}</span>
      {names.length > 0 ? (
        <span className="min-w-0 truncate" data-testid="group-delivery-members">
          · {namesSummary(names)}
        </span>
      ) : null}
    </div>
  );
}
