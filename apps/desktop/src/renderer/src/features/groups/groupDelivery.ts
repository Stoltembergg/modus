import type { GroupMessage } from "../../../../shared/contracts";
import { groupStatusLabel, resolveGroupRoomLocale } from "../../../../shared/group-room-locale";

/**
 * Delivery state of a room message, derived ONLY from the canonical turn cards
 * the runtime creates for it (`replyToMessageId` = trigger, `turnId` set; see
 * `GroupTurnTranscript`). There is deliberately no "read" state: the room only
 * knows whether a member's turn is queued, running, blocked on you, or how it
 * ended.
 *
 * Per member (all of its cards for this trigger):
 * - waiting    — a card is `awaiting_user` (blocked on an ask/approval from you)
 * - working    — a card is `running` / `writing`
 * - queued     — a card is `queued` (turn admitted, not started)
 * - failed     — a card is `failed` or `interrupted`
 * - cancelled  — a card is `cancelled`
 * - answered   — a public reply exists (non-empty `completed` message card)
 * - noReply    — the turn completed without any public text
 * `delivered` is message-level only: stored in the room, no turn card yet.
 *
 * Message state = the highest-priority member state (DELIVERY_PRIORITY):
 *   waiting > working > queued > delivered > failed > cancelled > noReply > answered
 * Rationale: what needs you first, then live work, then not-started; among
 * ended turns the footer reports the worst outcome (error before an explicit
 * stop before silence), so "answered" only shows when every woken member
 * answered. The footer names the members in the shown state and the tooltip
 * lists everyone, so a mixed outcome stays visible.
 */
export type GroupDeliveryState =
  | "waiting"
  | "working"
  | "queued"
  | "delivered"
  | "failed"
  | "cancelled"
  | "noReply"
  | "answered";

/** Highest priority first. */
export const DELIVERY_PRIORITY: readonly GroupDeliveryState[] = [
  "waiting",
  "working",
  "queued",
  "delivered",
  "failed",
  "cancelled",
  "noReply",
  "answered",
];

export const GROUP_DELIVERY_STATES = DELIVERY_PRIORITY;

export type GroupDeliveryMember = { sessionId: string; state: GroupDeliveryState };

export type GroupDelivery = {
  state: GroupDeliveryState;
  /** One entry per member woken by the message, in first-wake order. */
  members: GroupDeliveryMember[];
};

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

function cardState(card: GroupMessage): GroupDeliveryState {
  switch (card.status) {
    case "awaiting_user":
      return "waiting";
    case "running":
    case "writing":
      return "working";
    case "queued":
      return "queued";
    case "failed":
    case "interrupted":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      // completed (or a legacy card without status): did it say anything?
      return card.kind === "message" && card.body.trim() ? "answered" : "noReply";
  }
}

function highest(states: Iterable<GroupDeliveryState>): GroupDeliveryState | undefined {
  const present = new Set(states);
  return DELIVERY_PRIORITY.find((state) => present.has(state));
}

function memberState(cards: readonly GroupMessage[]): GroupDeliveryState {
  const states = cards.map(cardState);
  // Earlier cards of a turn stay `completed` once delivered; a public reply in
  // a turn that then completed silently is still an answer.
  if (states.includes("answered") && states.every((s) => s === "answered" || s === "noReply")) {
    return "answered";
  }
  return highest(states) ?? "noReply";
}

/**
 * Footer state for a message. User messages always have one (stored =
 * delivered until a turn exists). Agent messages only when they woke someone;
 * status rows never.
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
  return { state: highest(members.map((member) => member.state)) ?? "delivered", members };
}

/** States with no room key of their own; the rest share the card's labels. */
const OWN_LABELS: Record<
  "en" | "pt" | "zh",
  Record<"delivered" | "working" | "noReply" | "answered", string>
> = {
  en: { delivered: "Delivered", working: "Working", noReply: "No reply", answered: "Answered" },
  pt: {
    delivered: "Entregue",
    working: "Trabalhando",
    noReply: "Sem resposta",
    answered: "Respondida",
  },
  zh: { delivered: "已送达", working: "工作中", noReply: "无回复", answered: "已回复" },
};

/**
 * Footer labels. Waiting / queued / failed / cancelled use `groupStatusLabel`,
 * the same function as the member card badge, so both read the same words.
 */
export function groupDeliveryLabel(state: GroupDeliveryState, locale?: string | null): string {
  switch (state) {
    case "waiting":
      return groupStatusLabel("waitingForYou", locale);
    case "queued":
    case "failed":
    case "cancelled":
      return groupStatusLabel(state, locale);
    default:
      return OWN_LABELS[resolveGroupRoomLocale(locale)][state];
  }
}
