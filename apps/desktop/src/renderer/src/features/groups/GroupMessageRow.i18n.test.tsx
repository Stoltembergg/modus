// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessage, GroupMessageStatus } from "../../../../shared/contracts";
import { GroupMessageRow } from "./GroupMessageRow";
import { groupDeliveryLabel } from "./groupDelivery";

afterEach(cleanup);

const members = [{ sessionId: "s-a", title: "Alpha" }];
const labels = new Map([["s-a", { title: "Alpha" }]]);

function card(status: GroupMessageStatus, body = ""): GroupMessage {
  return {
    id: `m-${status}`,
    groupId: "g-1",
    authorKind: "agent",
    authorSessionId: "s-a",
    kind: "message",
    body,
    mentions: [],
    createdAt: "2026-10-02T12:00:00.000Z",
    turnId: "turn-1",
    chainId: "chain-1",
    status,
  };
}

function renderCard(status: GroupMessageStatus, locale: string, body = "") {
  return render(
    <GroupMessageRow
      labels={labels}
      locale={locale}
      members={members}
      message={card(status, body)}
      onRetry={async () => undefined}
    />,
  );
}

const BADGES: Record<string, Record<string, string>> = {
  en: {
    queued: "Queued",
    awaiting_user: "Waiting for you",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
  },
  "pt-BR": {
    queued: "Na fila",
    awaiting_user: "Aguardando você",
    completed: "Concluído",
    failed: "Falhou",
    cancelled: "Cancelado",
    interrupted: "Interrompido",
  },
  "zh-CN": {
    queued: "排队中",
    awaiting_user: "等待你",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  },
};

const PROGRESS: Record<string, Partial<Record<GroupMessageStatus, string>>> = {
  en: {
    queued: "Waiting for its turn",
    running: "Working on the task",
    awaiting_user: "Waiting for you",
  },
  "pt-BR": {
    queued: "Aguardando a vez",
    running: "Trabalhando na tarefa",
    awaiting_user: "Aguardando você",
  },
  "zh-CN": { queued: "等待轮到它", running: "正在处理任务", awaiting_user: "等待你" },
};

const RETRY: Record<string, { failed: string; cancelled: string }> = {
  en: { failed: "Retry task", cancelled: "Resume task" },
  "pt-BR": { failed: "Tentar de novo", cancelled: "Retomar tarefa" },
  "zh-CN": { failed: "重试任务", cancelled: "继续任务" },
};

describe.each(["en", "pt-BR", "zh-CN"])("member turn card in %s", (locale) => {
  it.each(Object.keys(BADGES.en ?? {}))("status badge for %s", (status) => {
    renderCard(status as GroupMessageStatus, locale, status === "completed" ? "Done." : "");
    expect(screen.getByTestId("group-message-status").textContent).toBe(BADGES[locale]?.[status]);
  });

  it.each(Object.keys(PROGRESS.en ?? {}))("fallback progress for %s", (status) => {
    renderCard(status as GroupMessageStatus, locale);
    const expected = PROGRESS[locale]?.[status as GroupMessageStatus] ?? "";
    expect(screen.getByTestId("group-message").textContent).toContain(expected);
  });

  it("writing fallback progress", () => {
    const writing = {
      en: "Writing a reply",
      "pt-BR": "Escrevendo uma resposta",
      "zh-CN": "正在撰写回复",
    };
    render(
      <GroupMessageRow
        labels={labels}
        locale={locale}
        members={members}
        message={{ ...card("writing"), body: "" }}
      />,
    );
    expect(screen.getByTestId("group-message").textContent).toContain(
      writing[locale as keyof typeof writing],
    );
  });

  it("retry and resume buttons", () => {
    const { unmount } = renderCard("failed", locale);
    expect(screen.getByRole("button", { name: RETRY[locale]?.failed ?? "" })).toBeTruthy();
    unmount();
    renderCard("cancelled", locale);
    expect(screen.getByRole("button", { name: RETRY[locale]?.cancelled ?? "" })).toBeTruthy();
  });

  it("card badge and delivery footer read the same words", () => {
    const pairs = [
      ["awaiting_user", "waiting"],
      ["queued", "queued"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ] as const;
    for (const [status, state] of pairs) {
      const { unmount } = renderCard(status, locale);
      expect(screen.getByTestId("group-message-status").textContent).toBe(
        groupDeliveryLabel(state, locale),
      );
      unmount();
    }
  });
});
