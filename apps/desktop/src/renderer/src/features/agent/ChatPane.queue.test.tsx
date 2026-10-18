// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { domMax, LazyMotion } from "motion/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventItem } from "../../../../shared/agent-events";
import type { AgentSessionInfo, QueuedPromptItem } from "../../../../shared/contracts";
import { AgentEventHub } from "./agentEventHub";
import { ChatPane } from "./ChatPane";

// Happy DOM's WAAPI cancel rejects unlike Motion's browser expectations.
const nativeAnimation = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Reflect.deleteProperty(Element.prototype, "animate");
  return descriptor;
});
afterAll(() => {
  if (nativeAnimation) Object.defineProperty(Element.prototype, "animate", nativeAnimation);
});

const SESSION: AgentSessionInfo = {
  id: "chat-queue",
  workspaceId: "project",
  cwd: "/repo",
  title: "Queue",
  status: "running",
  createdAt: "now",
  updatedAt: "now",
};

/** Any preload namespace/method the pane touches: async no-op, `on*` returns an unsubscribe. */
function autoApi(overrides: Record<string, Record<string, unknown>>) {
  const namespace = (name: string) =>
    new Proxy(overrides[name] ?? {}, {
      get(target, key) {
        if (typeof key !== "string") return undefined;
        if (key in target) return (target as Record<string, unknown>)[key];
        const fn = key.startsWith("on")
          ? vi.fn(() => () => undefined)
          : vi.fn(async () => undefined);
        (target as Record<string, unknown>)[key] = fn;
        return fn;
      },
    });
  const cache = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (!cache.has(key)) cache.set(key, namespace(key));
        return cache.get(key);
      },
    },
  );
}

const runningEvents: AgentEventItem[] = [
  {
    id: "run",
    event: { type: "run.started", sessionId: SESSION.id, runId: "run", delivery: "normal" },
  },
  {
    id: "busy",
    event: { type: "session.status", sessionId: SESSION.id, status: { type: "busy" } },
  },
];

function queued(id: string, text: string, imageCount = 0): QueuedPromptItem {
  return { id, delivery: "follow-up", text, imageCount };
}

afterEach(() => {
  cleanup();
  Object.assign(window, { modus: undefined });
  vi.restoreAllMocks();
});

function mount(initialQueue: QueuedPromptItem[], options: { workspace?: boolean } = {}) {
  let browserListener: ((event: unknown) => void) | undefined;
  const removeQueued = vi.fn(async () => ({ removed: true }));
  const prompt = vi.fn(async (_input: unknown) => undefined);
  const listQueue = vi.fn(async () => initialQueue);
  Object.assign(window, {
    modus: autoApi({
      agent: {
        listEventPage: vi.fn(async () => ({
          events: runningEvents,
          summaryEvents: [],
          activityEvents: [],
          snapshotCursor: 2,
          hasMore: false,
        })),
        listQueue,
        removeQueued,
        prompt,
        releaseRuntime: vi.fn(async () => undefined),
      },
      process: { list: vi.fn(async () => []) },
      browser: {
        onEvent: vi.fn((listener: (event: unknown) => void) => {
          browserListener = listener;
          return () => undefined;
        }),
      },
      diff: {
        sessionStats: vi.fn(async () => ({
          files: [],
          added: 0,
          removed: 0,
          fileCount: 0,
          truncated: false,
        })),
      },
    }),
  });
  const hub = new AgentEventHub();
  const view = render(
    <LazyMotion features={domMax} strict>
      <ChatPane
        session={SESSION}
        hub={hub}
        models={[]}
        defaultModel=""
        workspace={
          options.workspace
            ? ({ id: SESSION.workspaceId, rootPath: "/repo", name: "repo" } as never)
            : null
        }
        onModelChange={() => {}}
        onModelConfigChange={async () => {}}
        onOpenReview={() => {}}
        onPlanUpdated={() => {}}
        onSessionsChanged={() => {}}
      />
    </LazyMotion>,
  );
  const snapshot = (items: QueuedPromptItem[]) =>
    act(() => {
      hub.publish({
        id: `snapshot:${items.map(({ id }) => id).join(",")}:${Math.random()}`,
        event: { type: "queue.snapshot", sessionId: SESSION.id, items },
      });
    });
  const browserSubmit = (text: string) =>
    act(() => {
      browserListener?.({
        type: "browser.design-select",
        workspaceId: SESSION.workspaceId,
        tabId: "tab-1",
        intent: "submit",
        element: {
          id: "element-1",
          tabId: "tab-1",
          url: "http://localhost:5173",
          label: "Hero",
          tagName: "h1",
          domPath: "main > h1",
          rect: { x: 0, y: 0, width: 10, height: 10 },
          contentParts: [{ type: "text", text }],
        },
      });
    });
  return { view, hub, snapshot, removeQueued, listQueue, prompt, browserSubmit };
}

const rows = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-queued-prompt-id]")).map(
    (row) => row.dataset.queuedPromptId,
  );

describe("ChatPane visible queue", () => {
  it("seeds the strip from main and follows queue.snapshot by id, in arrival order", async () => {
    const { snapshot, listQueue } = mount([queued("a", "Then add a test")]);
    await waitFor(() => expect(rows()).toEqual(["a"]));
    expect(listQueue).toHaveBeenCalledWith(SESSION.id);

    snapshot([queued("a", "Then add a test"), queued("b", "Also check the docs", 2)]);
    await waitFor(() => expect(rows()).toEqual(["a", "b"]));
    const strip = screen.getByTestId("queued-prompt-strip");
    expect(within(strip).getByTestId("queued-prompt-images").textContent).toBe("2");

    // "a" was sent: it leaves the strip, "b" stays.
    snapshot([queued("b", "Also check the docs", 2)]);
    await waitFor(() => expect(rows()).toEqual(["b"]));
    snapshot([]);
    await waitFor(() => expect(screen.queryByTestId("queued-prompt-strip")).toBeNull());
  });

  it("remove asks the runtime to drop that id", async () => {
    const { removeQueued } = mount([queued("a", "Then add a test"), queued("b", "Drop me")]);
    await waitFor(() => expect(rows()).toEqual(["a", "b"]));
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message: Drop me" }));
    expect(removeQueued).toHaveBeenCalledWith({ sessionId: SESSION.id, id: "b" });
  });

  it("shows a queued prompt once: in the strip while queued, in chat only after it is sent", async () => {
    const { hub, snapshot } = mount([queued("a", "Then add a test")]);
    await waitFor(() => expect(rows()).toEqual(["a"]));
    const transcriptCount = () =>
      Array.from(document.querySelectorAll('[data-message-role="user"]')).filter((node) =>
        node.textContent?.includes("Then add a test"),
      ).length;
    expect(transcriptCount()).toBe(0);

    // Main emits the user message when pi sends it, then the emptier snapshot.
    act(() => {
      for (const [id, event] of [
        [
          "u1",
          {
            type: "message.started",
            sessionId: SESSION.id,
            messageId: "local-user:a",
            role: "user",
          },
        ],
        [
          "u2",
          {
            type: "message.delta",
            sessionId: SESSION.id,
            messageId: "local-user:a",
            delta: "Then add a test",
          },
        ],
        ["u3", { type: "message.completed", sessionId: SESSION.id, messageId: "local-user:a" }],
      ] as const) {
        hub.publish({ id, event } as AgentEventItem);
      }
    });
    snapshot([]);
    await waitFor(() => expect(transcriptCount()).toBe(1));
    await waitFor(() => expect(screen.queryByTestId("queued-prompt-strip")).toBeNull());
  });

  it("a prompt sent while the agent runs gets no optimistic chat bubble", async () => {
    const { hub, prompt, browserSubmit } = mount([], { workspace: true });
    await waitFor(() => expect(hub.getHistory(SESSION.id).length).toBeGreaterThan(0));
    browserSubmit("tighten the hero");
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ delivery: "follow-up" });
    const userEvents = hub
      .getHistory(SESSION.id)
      .filter(({ event }) => event.type === "message.started" && event.role === "user");
    expect(userEvents).toEqual([]);
    expect(document.querySelectorAll('[data-message-role="user"]')).toHaveLength(0);
  });
});
