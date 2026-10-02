import type { GroupMessage } from "../../../../shared/contracts";
import { resolveGroupRoomLocale } from "../../../../shared/group-room-locale";

/**
 * Delivery state of a room message, derived from the canonical turn cards the
 * runtime creates for it (`replyToMessageId` = trigger, `turnId` set). There is
 * deliberately no "read" state: the room only knows whether a member's turn is
 * queued, running, or produced a public reply.
 */
export type GroupDeliveryState = "queued" | "delivered" | "working" | "answered";

export const GROUP_DELIVERY_STATES: readonly GroupDeliveryState[] = [
  "queued",
  "delivered",
  "working",
  "answered",
];

export type GroupDeliveryMember = { sessionId: string; state: GroupDeliveryState };

export type GroupDelivery = {
  state: GroupDeliveryState;
  /** One entry per member woken by the message, in first-wake order. */
  members: GroupDeliveryMember[];
};

const ACTIVE = new Set<GroupMessage["status"]>(["running", "writing", "awaiting_user"]);
/** Highest first: an active member wins over a queued one, etc. */
const PRECEDENCE: readonly GroupDeliveryState[] = ["working", "queued", "answered", "delivered"];

/** Turn cards grouped by the message that woke them (trigger id). */
export function indexTurnRepliesByTrigger(
  messages: readonly GroupMessage[],
): Map<string, GroupMessage[]> {
  const byTrigger = new Map<string, GroupMessage[]>();
  for (const message of messages) {
    if (message.authorKind !== "agent" || !message.turnId || !message.replyToMessageId) continue;
    const list = byTrigger.get(message.replyToMessageId);
    if (list) list.push(message);
    else byTrigger.set(message.replyToMessageId, [message]);
  }
  return byTrigger;
}

function memberState(cards: readonly GroupMessage[]): GroupDeliveryState {
  if (cards.some((card) => ACTIVE.has(card.status))) return "working";
  if (cards.some((card) => card.status === "queued")) return "queued";
  // A public reply exists. Silent, failed or cancelled turns stay "delivered".
  if (
    cards.some(
      (card) =>
        card.kind === "message" &&
        Boolean(card.body.trim()) &&
        (card.status === "completed" || card.status === undefined),
    )
  ) {
    return "answered";
  }
  return "delivered";
}

/**
 * Footer state for a message. User messages always have one (persisted =
 * delivered). Agent messages only when they woke someone; status rows never.
 */
export function deriveGroupDelivery(
  message: GroupMessage,
  replies: readonly GroupMessage[] | undefined,
): GroupDelivery | undefined {
  if (message.kind !== "message") return undefined;
  if (message.authorKind !== "user" && message.authorKind !== "agent") return undefined;
  const bySession = new Map<string, GroupMessage[]>();
  for (const card of replies ?? []) {
    if (card.replyToMessageId !== message.id || !card.authorSessionId) continue;
    const list = bySession.get(card.authorSessionId);
    if (list) list.push(card);
    else bySession.set(card.authorSessionId, [card]);
  }
  if (bySession.size === 0) {
    return message.authorKind === "user" ? { state: "delivered", members: [] } : undefined;
  }
  const members = [...bySession].map(([sessionId, cards]) => ({
    sessionId,
    state: memberState(cards),
  }));
  const state =
    PRECEDENCE.find((candidate) => members.some((member) => member.state === candidate)) ??
    "delivered";
  return { state, members };
}

const LABELS: Record<"en" | "pt" | "zh", Record<GroupDeliveryState, string>> = {
  en: { queued: "Queued", delivered: "Delivered", working: "Working", answered: "Answered" },
  pt: { queued: "Na fila", delivered: "Entregue", working: "Trabalhando", answered: "Respondida" },
  zh: { queued: "排队中", delivered: "已送达", working: "工作中", answered: "已回复" },
};

export function groupDeliveryLabel(state: GroupDeliveryState, locale?: string | null): string {
  return LABELS[resolveGroupRoomLocale(locale)][state];
}
