import { describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import {
  deriveGroupDelivery,
  GROUP_DELIVERY_STATES,
  groupDeliveryLabel,
  indexTurnRepliesByTrigger,
} from "./groupDelivery";

function msg(id: string, extra: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id,
    groupId: "g-1",
    authorKind: "user",
    kind: "message",
    body: "Ship it",
    mentions: [],
    createdAt: "2026-10-02T12:00:00.000Z",
    ...extra,
  };
}

/** A canonical turn card the runtime creates for `trigger`. */
function card(
  id: string,
  sessionId: string,
  status: NonNullable<GroupMessage["status"]>,
  body = "",
  trigger = "u1",
): GroupMessage {
  return msg(id, {
    authorKind: "agent",
    authorSessionId: sessionId,
    replyToMessageId: trigger,
    turnId: `turn-${id}`,
    status,
    body,
  });
}

const user = msg("u1");

function stateOf(replies: GroupMessage[], message: GroupMessage = user) {
  return deriveGroupDelivery(message, indexTurnRepliesByTrigger(replies).get(message.id));
}

describe("deriveGroupDelivery", () => {
  it("delivered: a stored user message nobody has picked up yet", () => {
    expect(stateOf([])).toEqual({ state: "delivered", members: [] });
  });

  it("queued: every woken member is waiting for its turn", () => {
    expect(stateOf([card("c1", "s-a", "queued"), card("c2", "s-b", "queued")])).toEqual({
      state: "queued",
      members: [
        { sessionId: "s-a", state: "queued" },
        { sessionId: "s-b", state: "queued" },
      ],
    });
  });

  it.each([
    "running",
    "writing",
    "awaiting_user",
  ] as const)("working: a member turn is %s", (status) => {
    expect(stateOf([card("c1", "s-a", status)])?.state).toBe("working");
  });

  it("answered: a member posted a public reply", () => {
    expect(stateOf([card("c1", "s-a", "completed", "Done, see PR")])?.state).toBe("answered");
  });

  it("an active member wins over queued and answered ones", () => {
    const replies = [
      card("c1", "s-a", "completed", "Done"),
      card("c2", "s-b", "queued"),
      card("c3", "s-c", "running"),
    ];
    expect(stateOf(replies)?.state).toBe("working");
    expect(stateOf(replies.slice(0, 2))?.state).toBe("queued");
  });

  it("silent, failed or cancelled turns leave the message delivered (no reply)", () => {
    expect(stateOf([card("c1", "s-a", "completed", "")])?.state).toBe("delivered");
    expect(stateOf([card("c1", "s-a", "failed", "partial")])?.state).toBe("delivered");
    expect(stateOf([card("c1", "s-a", "cancelled")])?.state).toBe("delivered");
  });

  it("a member with several cards in one turn counts once", () => {
    const delivery = stateOf([
      card("c1", "s-a", "completed", "First part"),
      card("c2", "s-a", "writing", "Second"),
    ]);
    expect(delivery).toEqual({
      state: "working",
      members: [{ sessionId: "s-a", state: "working" }],
    });
  });

  it("ignores quote replies (no turn) and cards for other messages", () => {
    const quote = msg("q1", { replyToMessageId: "u1", body: "+1" });
    const other = card("c9", "s-a", "running", "", "u2");
    expect(stateOf([quote, other])).toEqual({ state: "delivered", members: [] });
  });

  it("agent messages get a footer only when they woke someone; status rows never", () => {
    const agent = msg("a1", { authorKind: "agent", authorSessionId: "s-a", body: "@Beta review" });
    expect(stateOf([], agent)).toBeUndefined();
    expect(stateOf([card("c1", "s-b", "queued", "", "a1")], agent)?.state).toBe("queued");
    expect(stateOf([], msg("s1", { kind: "status" }))).toBeUndefined();
    expect(stateOf([], msg("x1", { authorKind: "system" }))).toBeUndefined();
  });
});

describe("groupDeliveryLabel", () => {
  it("labels the four states in English and Portuguese", () => {
    expect(GROUP_DELIVERY_STATES.map((state) => groupDeliveryLabel(state, "en-US"))).toEqual([
      "Queued",
      "Delivered",
      "Working",
      "Answered",
    ]);
    expect(GROUP_DELIVERY_STATES.map((state) => groupDeliveryLabel(state, "pt-BR"))).toEqual([
      "Na fila",
      "Entregue",
      "Trabalhando",
      "Respondida",
    ]);
  });

  it("has no read receipt state in any locale", () => {
    expect(GROUP_DELIVERY_STATES).not.toContain("read");
    for (const locale of ["en", "pt-BR", "zh-CN"]) {
      for (const state of GROUP_DELIVERY_STATES) {
        expect(groupDeliveryLabel(state, locale)).not.toMatch(/read|lid[oa]|seen|visto|已读/i);
      }
    }
  });
});
