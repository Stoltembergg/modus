import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isSupported: vi.fn(() => true),
  currentUiLocale: vi.fn(() => "pt"),
  getAgentSession: vi.fn(() => ({ title: "Atlas" })),
  notifications: [] as Array<{
    options: unknown;
    onClick?: () => void;
    show: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("electron", () => ({
  Notification: class {
    static isSupported() {
      return mocks.isSupported();
    }
    onClick: (() => void) | undefined;
    show = vi.fn(() => undefined);
    constructor(options: unknown) {
      mocks.notifications.push({ options, show: this.show });
    }
    on(event: string, handler: () => void) {
      if (event === "click") {
        this.onClick = handler;
        const notification = mocks.notifications.at(-1);
        if (notification) notification.onClick = handler;
      }
    }
  },
}));
vi.mock("../agent/agent-store", () => ({ getAgentSession: mocks.getAgentSession }));
vi.mock("../locale/ui-language-controller", () => ({ currentUiLocale: mocks.currentUiLocale }));

const { maybeNotifyAgentEvent } = await import("./agent-notifications");

describe("agent notifications", () => {
  const windowMock = {
    isDestroyed: () => false,
    isFocused: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
  const window = windowMock as never;

  beforeEach(() => {
    mocks.notifications.length = 0;
    mocks.isSupported.mockReturnValue(true);
    mocks.getAgentSession.mockReturnValue({ title: "Atlas" });
    windowMock.webContents.send.mockClear();
  });

  it("notifies when a background conversation asks the user a question", () => {
    maybeNotifyAgentEvent(window, {
      type: "question.requested",
      sessionId: "session-1",
      request: {
        id: "question-1",
        questions: [{ id: "choice", header: "Which option?", multiSelect: false, options: [] }],
      },
    });

    expect(mocks.notifications).toHaveLength(1);
    expect(mocks.notifications[0]?.options).toEqual({
      title: "Atlas",
      body: "O agente está aguardando sua resposta.",
      silent: false,
    });
    expect(mocks.notifications[0]?.show).toHaveBeenCalledOnce();
  });

  it("does not notify while the Modus window is focused", () => {
    const focusedWindow = { ...windowMock, isFocused: () => true } as never;
    maybeNotifyAgentEvent(focusedWindow, {
      type: "question.requested",
      sessionId: "session-1",
      request: {
        id: "question-1",
        questions: [{ id: "choice", header: "Which option?", multiSelect: false, options: [] }],
      },
    });

    expect(mocks.notifications).toHaveLength(0);
  });
});
