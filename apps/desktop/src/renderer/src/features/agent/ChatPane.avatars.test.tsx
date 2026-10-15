// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { domMax, LazyMotion } from "motion/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentEventItem } from "../../../../shared/agent-events";
import type { AgentInfo, AgentSessionInfo } from "../../../../shared/contracts";
import { WorkFold } from "./ActivityGroup";
import { ActivityTimeline } from "./ActivityTimeline";
import { AgentEventHub } from "./agentEventHub";
import { ChatPane } from "./ChatPane";

// Happy DOM's WAAPI cancel rejects unlike Motion's browser expectations.
// Keep real Motion components using their supported JS animation fallback.
const nativeAnimation = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Reflect.deleteProperty(Element.prototype, "animate");
  return descriptor;
});
afterAll(() => {
  if (nativeAnimation) Object.defineProperty(Element.prototype, "animate", nativeAnimation);
});

// Exercise the actual animated Markdown renderer, not its cold-load fallback.
beforeAll(async () => {
  await import("./MarkdownMessageRenderer");
});

const AGENT: AgentInfo = {
  id: "judas",
  name: "Judas",
  role: "",
  instructions: "",
  avatarColor: "green",
  avatarFace: "happy",
  avatarShape: "blob",
  createdAt: "now",
  updatedAt: "now",
};
const SESSION: AgentSessionInfo = {
  id: "chat-judas",
  agentId: AGENT.id,
  workspaceId: "project",
  cwd: "/repo",
  title: "Judas",
  status: "running",
  createdAt: "now",
  updatedAt: "now",
};
afterEach(() => {
  cleanup();
  Object.assign(window, { modus: undefined });
  vi.restoreAllMocks();
});

describe("ChatPane message author wiring", () => {
  it.each([
    false,
    true,
  ])("keeps live activity visible for subagents (%s) and preserves the final answer and avatar", async (subagent) => {
    const events: AgentEventItem[] = [
      {
        id: "run",
        event: { type: "run.started", sessionId: SESSION.id, runId: "run", delivery: "normal" },
      },
      {
        id: "message",
        event: {
          type: "message.started",
          sessionId: SESSION.id,
          messageId: "answer",
          role: "assistant",
        },
      },
      {
        id: "text",
        event: {
          type: "thinking.delta",
          sessionId: SESSION.id,
          messageId: "answer",
          delta: "Inspect the relevant source first.",
        },
      },
    ];
    Object.assign(window, {
      modus: {
        agent: {
          listEventPage: vi.fn(async () => ({
            events,
            summaryEvents: [],
            activityEvents: [],
            snapshotCursor: 3,
            hasMore: false,
          })),
          releaseRuntime: vi.fn(async () => undefined),
        },
        process: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => undefined) },
        diff: {
          sessionStats: vi.fn(async () => ({
            files: [],
            added: 0,
            removed: 0,
            fileCount: 0,
            truncated: false,
          })),
        },
      },
    });
    const hub = new AgentEventHub();
    const pane = (agent: AgentInfo) => (
      <LazyMotion features={domMax} strict>
        <ChatPane
          assistantAgent={agent}
          session={subagent ? { ...SESSION, parentSessionId: "parent" } : SESSION}
          hub={hub}
          models={[]}
          defaultModel=""
          workspace={null}
          hideComposer
          onModelChange={() => {}}
          onModelConfigChange={async () => {}}
          onOpenReview={() => {}}
          onPlanUpdated={() => {}}
          onSessionsChanged={() => {}}
        />
      </LazyMotion>
    );
    const view = render(pane(AGENT));
    await waitFor(() => expect(hub.getHistory(SESSION.id)).toHaveLength(3));
    if (subagent) {
      await waitFor(() => expect(view.container.textContent).toContain("Thinking"));
    } else {
      expect(view.container.textContent).not.toContain("Thinking");
    }
    act(() => {
      hub.publish({
        id: "thinking-end",
        event: {
          type: "thinking.completed",
          sessionId: SESSION.id,
          messageId: "answer",
        },
      });
      hub.publish({
        id: "read-start",
        event: {
          type: "tool.started",
          sessionId: SESSION.id,
          runId: "run",
          toolCallId: "read",
          toolName: "read",
          args: { path: "/repo/preview.ts" },
        },
      });
    });
    if (subagent) {
      await waitFor(() => expect(view.container.textContent).toContain("preview.ts"));
    } else {
      expect(view.container.textContent).not.toContain("preview.ts");
    }
    act(() => {
      hub.publish({
        id: "read-end",
        event: {
          type: "tool.ended",
          sessionId: SESSION.id,
          runId: "run",
          toolCallId: "read",
          isError: false,
        },
      });
      hub.publish({
        id: "reply",
        event: {
          type: "message.delta",
          sessionId: SESSION.id,
          messageId: "answer",
          delta: "A real rendered reply.",
        },
      });
    });
    if (subagent) {
      const liveAvatar = await screen.findByRole("img", { name: "Judas" });
      const liveCard = liveAvatar.parentElement?.querySelector('[data-message-role="assistant"]');
      await waitFor(() => expect(liveCard?.textContent).toContain("A real rendered reply."));
      expect(liveAvatar.getAttribute("data-state")).toBe("working");
    } else {
      // Main conversations retain the separate Activity presentation.
      expect(screen.queryByRole("img", { name: "Judas" })).toBeNull();
    }
    act(() => {
      hub.publish({
        id: "end-message",
        event: { type: "message.completed", sessionId: SESSION.id, messageId: "answer" },
      });
      hub.publish({
        id: "end-run",
        event: { type: "run.completed", sessionId: SESSION.id, runId: "run" },
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Judas" }).getAttribute("data-state")).toBe("idle"),
    );
    const avatar = screen.getByRole("img", { name: "Judas" });
    expect(avatar.getAttribute("data-color")).toBe("green");
    expect(avatar.getAttribute("data-state")).toBe("idle");
    expect(avatar.getAttribute("data-paused")).not.toBe("true");
    expect(await screen.findByText("A real rendered reply.")).toBeTruthy();
    view.rerender(pane({ ...AGENT, avatarColor: "teal" }));
    expect(screen.getByRole("img", { name: "Judas" })).toBe(avatar);
    expect(avatar.getAttribute("data-color")).toBe("teal");
    expect(avatar.getAttribute("data-paused")).not.toBe("true");
    expect(screen.getByText("A real rendered reply.")).toBeTruthy();
  });
});

describe("Activity author wiring", () => {
  it("uses the same Agent identity for partial replies in the real Activity timeline", async () => {
    const events: AgentEventItem[] = [
      {
        id: "live-run",
        event: {
          type: "run.started",
          sessionId: SESSION.id,
          runId: "live-run",
          delivery: "normal",
        },
      },
      {
        id: "message",
        event: {
          type: "message.started",
          sessionId: SESSION.id,
          messageId: "partial",
          role: "assistant",
        },
      },
      {
        id: "delta",
        event: {
          type: "message.delta",
          sessionId: SESSION.id,
          messageId: "partial",
          delta: "Still writing",
        },
      },
    ];
    Object.assign(window, {
      modus: {
        agent: {
          listEventPage: vi.fn(async () => ({
            events,
            summaryEvents: [],
            activityEvents: [],
            snapshotCursor: 3,
            hasMore: false,
          })),
        },
      },
    });
    render(
      <LazyMotion features={domMax} strict>
        <ActivityTimeline
          assistantAgent={AGENT}
          assistantAgentId={AGENT.id}
          sessionId={SESSION.id}
          cwd={SESSION.cwd}
          hub={new AgentEventHub()}
        />
      </LazyMotion>,
    );
    const avatar = await screen.findByRole("img", { name: "Judas" });
    expect(avatar.getAttribute("data-state")).toBe("working");
    expect(avatar.getAttribute("data-paused")).not.toBe("true");
    const card = avatar.parentElement?.querySelector('[data-message-role="assistant"]');
    await waitFor(() => expect(card?.textContent).toContain("Still writing"));
  });

  it("keeps the profile identity for a response nested inside an execution fold", async () => {
    render(
      <LazyMotion features={domMax} strict>
        <WorkFold
          assistantAgent={AGENT}
          assistantAgentId={AGENT.id}
          run={{ type: "run", id: "run", runId: "run", status: "running", startedAt: Date.now() }}
          items={[
            {
              type: "message",
              id: "nested",
              role: "assistant",
              content: "Nested partial reply",
              streaming: true,
            },
          ]}
        />
      </LazyMotion>,
    );
    const avatar = await screen.findByRole("img", { name: "Judas" });
    expect(avatar.getAttribute("data-state")).toBe("working");
    expect(avatar.getAttribute("data-paused")).not.toBe("true");
  });
});
