// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { GroupDeliveryFooter, GroupMessageHeader } from "./GroupMessageHeader";
import { GroupMessageList } from "./GroupMessageList";
import { GROUP_DELIVERY_STATES, type GroupDelivery } from "./groupDelivery";

afterEach(cleanup);

const labels = new Map([
  ["s-a", { title: "Alpha" }],
  ["s-b", { title: "Beta" }],
  ["s-c", { title: "Gamma" }],
]);

describe("GroupMessageHeader", () => {
  it("renders avatar, name · time with a decorative dot", () => {
    render(
      <GroupMessageHeader
        avatar={<span data-testid="avatar" />}
        createdAt="2026-10-02T12:30:00.000Z"
        name="Alpha"
        memberRole="Researcher"
      />,
    );
    const header = screen.getByTestId("group-message-header");
    expect(within(header).getByTestId("avatar")).toBeTruthy();
    expect(header.textContent).toContain("Alpha");
    expect(header.textContent).toContain("Researcher");
    expect(screen.getByTestId("group-message-header-dot").getAttribute("aria-hidden")).toBe("true");
    const time = header.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe("2026-10-02T12:30:00.000Z");
    expect(time?.textContent?.trim()).toBeTruthy();
  });
});

describe("GroupDeliveryFooter", () => {
  it.each([
    ["waiting", "Waiting for you"],
    ["working", "Working"],
    ["queued", "Queued"],
    ["delivered", "Delivered"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["noReply", "No reply"],
    ["answered", "Answered"],
  ] as const)("%s state", (state, label) => {
    const delivery: GroupDelivery = {
      state,
      members: state === "delivered" ? [] : [{ sessionId: "s-a", state }],
    };
    render(<GroupDeliveryFooter align="end" delivery={delivery} labels={labels} locale="en" />);
    const footer = screen.getByTestId("group-delivery-status");
    expect(footer.dataset.delivery).toBe(state);
    expect(footer.textContent).toContain(label);
    if (state !== "delivered") expect(footer.textContent).toContain("Alpha");
  });

  it("names members in the shown state and lists everyone in the tooltip", () => {
    render(
      <GroupDeliveryFooter
        align="start"
        delivery={{
          state: "working",
          members: [
            { sessionId: "s-a", state: "working" },
            { sessionId: "s-b", state: "answered" },
          ],
        }}
        labels={labels}
        locale="en"
      />,
    );
    const footer = screen.getByTestId("group-delivery-status");
    expect(screen.getByTestId("group-delivery-members").textContent).toBe("· Alpha");
    expect(footer.getAttribute("title")).toBe("Alpha: Working · Beta: Answered");
    // Spinner respects reduced motion.
    expect(footer.querySelector("svg")?.getAttribute("class")).toContain(
      "motion-reduce:animate-none",
    );
  });

  it("waiting for you and failed use the member card tones", () => {
    const { unmount } = render(
      <GroupDeliveryFooter
        align="end"
        delivery={{ state: "waiting", members: [{ sessionId: "s-a", state: "waiting" }] }}
        labels={labels}
        locale="pt-BR"
      />,
    );
    const footer = screen.getByTestId("group-delivery-status");
    expect(footer.textContent).toContain("Aguardando você");
    expect(footer.className).toContain("text-amber-400");
    unmount();
    render(
      <GroupDeliveryFooter
        align="end"
        delivery={{ state: "failed", members: [{ sessionId: "s-a", state: "failed" }] }}
        labels={labels}
        locale="pt-BR"
      />,
    );
    expect(screen.getByTestId("group-delivery-status").textContent).toContain("Falhou");
    expect(screen.getByTestId("group-delivery-status").className).toContain("text-danger");
  });

  it("uses Portuguese labels for pt locales", () => {
    render(
      <GroupDeliveryFooter
        align="end"
        delivery={{ state: "answered", members: [{ sessionId: "s-a", state: "answered" }] }}
        labels={labels}
        locale="pt-BR"
      />,
    );
    expect(screen.getByTestId("group-delivery-status").textContent).toContain("Respondida");
  });

  it("never renders a read receipt", () => {
    for (const state of GROUP_DELIVERY_STATES) {
      for (const locale of ["en", "pt-BR"]) {
        const { unmount } = render(
          <GroupDeliveryFooter
            align="end"
            delivery={{ state, members: [{ sessionId: "s-a", state }] }}
            labels={labels}
            locale={locale}
          />,
        );
        expect(screen.getByTestId("group-delivery-status").textContent).not.toMatch(
          /\bread\b|lid[oa]|seen|visto/i,
        );
        unmount();
      }
    }
  });
});

function message(id: string, extra: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id,
    groupId: "g-1",
    authorKind: "user",
    kind: "message",
    body: `Message ${id}`,
    mentions: [],
    createdAt: "2026-10-02T12:30:00.000Z",
    ...extra,
  };
}

function turn(
  id: string,
  sessionId: string,
  trigger: string,
  status: NonNullable<GroupMessage["status"]>,
  body = "",
): GroupMessage {
  return message(id, {
    authorKind: "agent",
    authorSessionId: sessionId,
    replyToMessageId: trigger,
    turnId: `t-${id}`,
    status,
    body,
  });
}

function renderList(messages: GroupMessage[]) {
  return render(
    <GroupMessageList
      avatars={new Map()}
      cwd={undefined}
      error={undefined}
      groupId="g-1"
      hasOlder={false}
      loadOlder={async () => undefined}
      loaded
      loadingOlder={false}
      memberStates={new Map()}
      members={[
        { sessionId: "s-a", title: "Alpha" },
        { sessionId: "s-b", title: "Beta" },
      ]}
      messages={messages}
      onOpenFile={undefined}
      workingRows={[]}
    />,
  );
}

function footerOf(messageId: string): HTMLElement | null {
  const row = document.querySelector(`[data-message-id="${messageId}"]`);
  return row?.parentElement?.querySelector('[data-testid="group-delivery-status"]') ?? null;
}

describe("GroupMessageList delivery footers", () => {
  it("derives each user message state from its turn cards", () => {
    renderList([
      message("u-delivered"),
      message("u-queued"),
      turn("c1", "s-a", "u-queued", "queued"),
      message("u-working"),
      turn("c2", "s-a", "u-working", "completed", "First"),
      turn("c3", "s-b", "u-working", "running"),
      message("u-answered"),
      turn("c4", "s-b", "u-answered", "completed", "All done"),
      message("u-waiting"),
      turn("c5", "s-a", "u-waiting", "awaiting_user"),
      turn("c6", "s-b", "u-waiting", "running"),
      message("u-failed"),
      turn("c7", "s-a", "u-failed", "failed"),
      message("u-cancelled"),
      turn("c8", "s-a", "u-cancelled", "cancelled"),
      message("u-silent"),
      turn("c9", "s-a", "u-silent", "completed", ""),
    ]);
    expect(footerOf("u-delivered")?.dataset.delivery).toBe("delivered");
    expect(footerOf("u-queued")?.dataset.delivery).toBe("queued");
    expect(footerOf("u-working")?.dataset.delivery).toBe("working");
    expect(footerOf("u-working")?.textContent).toContain("Beta");
    expect(footerOf("u-answered")?.dataset.delivery).toBe("answered");
    expect(footerOf("u-waiting")?.dataset.delivery).toBe("waiting");
    expect(footerOf("u-failed")?.dataset.delivery).toBe("failed");
    expect(footerOf("u-cancelled")?.dataset.delivery).toBe("cancelled");
    // The silent card itself is hidden from the transcript, but still counts.
    expect(footerOf("u-silent")?.dataset.delivery).toBe("noReply");
    // Turn cards themselves woke nobody: no footer.
    expect(footerOf("c4")).toBeNull();
    // Header: small avatar + name · time on every card.
    for (const row of screen.getAllByTestId("group-message")) {
      expect(within(row).getByTestId("group-message-header").querySelector("time")).toBeTruthy();
    }
  });

  it("an agent message that woke a peer shows that peer's state", () => {
    renderList([
      message("a1", { authorKind: "agent", authorSessionId: "s-a", body: "@Beta please review" }),
      turn("c1", "s-b", "a1", "writing", "Looking"),
    ]);
    expect(footerOf("a1")?.dataset.delivery).toBe("working");
  });
});
