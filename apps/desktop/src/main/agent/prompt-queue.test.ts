import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedPromptItem } from "../../shared/contracts";
import { PromptQueue } from "./prompt-queue";

/** pi-agent-core's PendingMessageQueue, one-at-a-time drain. */
class FakePendingQueue {
  messages: unknown[] = [];
  drain(): unknown[] {
    const first = this.messages[0];
    if (!first) return [];
    this.messages = this.messages.slice(1);
    return [first];
  }
}

function fakePiSession() {
  const steeringQueue = new FakePendingQueue();
  const followUpQueue = new FakePendingQueue();
  const steeringTexts: string[] = [];
  const followUpTexts: string[] = [];
  const agent = {
    steeringQueue,
    followUpQueue,
    steer: vi.fn((message: unknown) => steeringQueue.messages.push(message)),
    followUp: vi.fn((message: unknown) => followUpQueue.messages.push(message)),
  };
  /** What pi's `prompt(text, { streamingBehavior })` does while streaming. */
  const prompt = async (text: string, behavior: "steer" | "followUp") => {
    const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    if (behavior === "steer") {
      steeringTexts.push(text);
      agent.steer(message);
    } else {
      followUpTexts.push(text);
      agent.followUp(message);
    }
  };
  return {
    agent,
    prompt,
    steeringTexts,
    followUpTexts,
    session: {
      agent,
      getSteeringMessages: () => steeringTexts,
      getFollowUpMessages: () => followUpTexts,
    },
  };
}

type Payload = { text: string };

function item(id: string, text: string, delivery: QueuedPromptItem["delivery"] = "follow-up") {
  return { id, delivery, text, imageCount: 0 } satisfies QueuedPromptItem;
}

function setup() {
  const pi = fakePiSession();
  const snapshots: QueuedPromptItem[][] = [];
  const queue = PromptQueue.attach<Payload>(pi.session, (items) => snapshots.push(items));
  if (!queue) throw new Error("expected a ledger");
  const enqueue =
    (text: string, behavior: "steer" | "followUp" = "followUp") =>
    async () =>
    () =>
      pi.prompt(text, behavior);
  const add = async (
    id: string,
    text: string,
    delivery: QueuedPromptItem["delivery"] = "follow-up",
  ) => {
    queue.add(item(id, text, delivery), { text });
    return queue.deliver(id, enqueue(text, delivery === "steer" ? "steer" : "followUp"));
  };
  return { pi, queue, snapshots, add };
}

describe("PromptQueue", () => {
  it("lists queued prompts by their id, in arrival order, and maps each to pi's message", async () => {
    const { pi, queue, snapshots, add } = setup();
    await add("a", "first");
    await add("b", "second", "steer");
    await add("c", "third");

    expect(queue.items().map(({ id, text }) => [id, text])).toEqual([
      ["a", "first"],
      ["b", "second"],
      ["c", "third"],
    ]);
    expect(snapshots.at(-1)?.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    // Consumed out of position order (steer first): the id still resolves to its own prompt.
    const [steer] = pi.agent.steeringQueue.drain();
    expect(queue.consume(steer)).toEqual({ text: "second" });
    expect(queue.items().map(({ id }) => id)).toEqual(["a", "c"]);
  });

  it("drops an item from the strip once pi sends it", async () => {
    const { pi, queue, snapshots, add } = setup();
    await add("a", "first");
    const [sent] = pi.agent.followUpQueue.drain();
    expect(queue.consume(sent)).toEqual({ text: "first" });
    expect(queue.items()).toEqual([]);
    expect(snapshots.at(-1)).toEqual([]);
  });

  it("removes exactly the targeted prompt from pi's queue (and pi's display mirror)", async () => {
    const { pi, queue, add } = setup();
    await add("a", "same text");
    await add("b", "same text");
    await add("c", "other");
    const [, second] = pi.agent.followUpQueue.messages;

    expect(queue.remove("b")).toEqual({ removed: true });

    expect(pi.agent.followUpQueue.messages).not.toContain(second);
    expect(pi.agent.followUpQueue.messages).toHaveLength(2);
    expect(pi.followUpTexts).toEqual(["same text", "other"]);
    expect(queue.items().map(({ id }) => id)).toEqual(["a", "c"]);
    expect(queue.remove("b")).toEqual({ removed: false });
  });

  it("never sends a prompt removed while its message was still being prepared", async () => {
    const { pi, queue } = setup();
    let finishPrepare!: () => void;
    const prepared = new Promise<void>((resolve) => {
      finishPrepare = resolve;
    });
    queue.add(item("a", "slow"), { text: "slow" });
    const delivery = queue.deliver("a", async () => {
      await prepared;
      return () => pi.prompt("slow", "followUp");
    });
    expect(queue.remove("a")).toEqual({ removed: true });
    finishPrepare();
    await expect(delivery).resolves.toBeUndefined();
    expect(pi.agent.followUpQueue.messages).toEqual([]);
    expect(queue.items()).toEqual([]);
  });

  it("race: pi consumes one item while the user removes another; only the removed one is lost", async () => {
    const { pi, queue, add } = setup();
    await add("a", "consumed");
    await add("b", "removed");
    await add("c", "kept");

    // pi drains "a" for its next turn; its message_start has not fired yet.
    const drained = pi.agent.followUpQueue.drain();
    // The user clicks remove on "a" (too late) and on "b" in the same tick.
    expect(queue.remove("a")).toEqual({ removed: false });
    expect(queue.remove("b")).toEqual({ removed: true });
    // pi now announces the drained message: it is "a", which is sent.
    expect(queue.consume(drained[0])).toEqual({ text: "consumed" });

    const remaining = pi.agent.followUpQueue.messages.map(
      (message) => (message as { content: Array<{ text: string }> }).content[0]?.text,
    );
    expect(remaining).toEqual(["kept"]);
    expect(queue.items().map(({ id }) => id)).toEqual(["c"]);
  });

  it("delivers one prompt at a time in arrival order", async () => {
    const { pi, queue } = setup();
    let releaseFirst!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    queue.add(item("a", "first"), { text: "first" });
    queue.add(item("b", "second"), { text: "second" });
    const first = queue.deliver("a", async () => {
      await slow;
      return () => pi.prompt("first", "followUp");
    });
    const second = queue.deliver("b", async () => () => pi.prompt("second", "followUp"));
    await Promise.resolve();
    expect(pi.agent.followUpQueue.messages).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(pi.followUpTexts).toEqual(["first", "second"]);
  });

  it("hands back a prompt pi took without queueing so it can be shown in chat", async () => {
    const { queue } = setup();
    queue.add(item("a", "handled"), { text: "handled" });
    await expect(queue.deliver("a", async () => async () => undefined)).resolves.toEqual({
      text: "handled",
    });
    expect(queue.items()).toEqual([]);
  });

  it("refuses to attach to a pi whose queue it does not know", () => {
    expect(PromptQueue.attach({ agent: { thinkingBudgets: undefined } }, () => {})).toBeUndefined();
    expect(PromptQueue.attach({}, () => {})).toBeUndefined();
  });

  it("clear() empties the strip when the pi session goes away", async () => {
    const { queue, snapshots, add } = setup();
    await add("a", "first");
    expect(queue.clear()).toBe(true);
    expect(snapshots.at(-1)).toEqual([]);
  });
});

/**
 * Same race against the real pi SDK: its Agent drains the follow-up queue and
 * then emits `turn_start` before the drained message's `message_start`. The
 * user removes both the drained item and a waiting one inside that gap.
 */
describe("PromptQueue on a real pi session", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function offlineSession(): Promise<{
    session: AgentSession;
    delivered: string[][];
    releaseFirst: () => void;
  }> {
    dir = await mkdtemp(join(tmpdir(), "modus-prompt-queue-"));
    const authStorage = AuthStorage.inMemory({
      mock: { type: "api_key", key: "offline-test-only" },
    });
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: SettingsManager.inMemory({}),
      model: {
        id: "offline",
        name: "offline",
        provider: "mock",
        api: "openai-completions",
        baseUrl: "https://offline.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1000,
      },
    });
    const delivered: string[][] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    session.agent.streamFn = (model, context) => {
      delivered.push(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          ),
      );
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
      const finish = () => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
      };
      if (delivered.length === 1) void firstGate.then(finish);
      else queueMicrotask(finish);
      return stream as unknown as ReturnType<AgentSession["agent"]["streamFn"]>;
    };
    return { session, delivered, releaseFirst };
  }

  it("removes the waiting prompt and still sends the one pi already took", async () => {
    const { session, delivered, releaseFirst } = await offlineSession();
    const queue = PromptQueue.attach<Payload>(session, () => {});
    if (!queue) throw new Error("pi's queue shape changed; see prompt-queue.ts");

    const consumed: string[] = [];
    const removals: Array<[string, boolean]> = [];
    let turns = 0;
    session.subscribe((event) => {
      if (event.type === "turn_start") {
        turns += 1;
        // Turn 2 starts after pi drained follow-up "a" and before its message_start.
        if (turns === 2) {
          removals.push(["a", queue.remove("a").removed]);
          removals.push(["b", queue.remove("b").removed]);
        }
      }
      if (event.type === "message_start") {
        const payload = queue.consume(event.message);
        if (payload) consumed.push(payload.text);
      }
    });

    const running = session.prompt("start");
    await vi.waitFor(() => expect(session.isStreaming).toBe(true));
    for (const [id, text] of [
      ["a", "follow-up a"],
      ["b", "follow-up b"],
    ] as const) {
      queue.add(item(id, text), { text });
      await queue.deliver(
        id,
        async () => () => session.prompt(text, { streamingBehavior: "followUp" }),
      );
    }
    expect(queue.items().map(({ id }) => id)).toEqual(["a", "b"]);

    releaseFirst();
    await running;
    await session.agent.waitForIdle();

    expect(removals).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(consumed).toEqual(["follow-up a"]);
    const everythingSent = delivered.flat();
    expect(everythingSent).toContain("follow-up a");
    expect(everythingSent).not.toContain("follow-up b");
    expect(session.getFollowUpMessages()).toEqual([]);
    expect(queue.items()).toEqual([]);
    session.dispose();
  });
});

/**
 * Aborting the running turn with prompts still queued (pi 0.80.6).
 *
 * pi's `AgentSession.abort()` only aborts the active run: it does not clear
 * `steeringQueue` / `followUpQueue` (only `clearQueue()` / `reset()` do). The
 * aborted run ends with `agent_end`, and pi's post-run check
 * (`_handlePostAgentRun` → `agent.hasQueuedMessages()`) then continues the
 * session with the prompts that are still queued. So the strip must keep them
 * through the aborted run's `agent_end` (reconcile) and drop each one when pi
 * actually sends it, ending empty and consistent with pi.
 */
describe("PromptQueue when the turn is aborted with prompts queued", () => {
  it("reconcile on agent_end keeps prompts pi still holds and drops ones pi cleared", async () => {
    const { pi, queue, snapshots, add } = setup();
    await add("a", "follow-up a");
    await add("b", "follow-up b");
    // Abort: pi keeps its queues, so agent_end's reconcile changes nothing.
    queue.reconcile();
    expect(queue.items().map(({ id }) => id)).toEqual(["a", "b"]);
    // If pi (or a later Modus change) clears its queue on abort, the strip follows.
    pi.agent.followUpQueue.messages = [];
    queue.reconcile();
    expect(queue.items()).toEqual([]);
    expect(snapshots.at(-1)).toEqual([]);
  });

  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("on a real pi session: abort keeps the queue, pi then sends each prompt once and the strip ends empty", async () => {
    dir = await mkdtemp(join(tmpdir(), "modus-prompt-queue-abort-"));
    const authStorage = AuthStorage.inMemory({
      mock: { type: "api_key", key: "offline-test-only" },
    });
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: SettingsManager.inMemory({}),
      model: {
        id: "offline",
        name: "offline",
        provider: "mock",
        api: "openai-completions",
        baseUrl: "https://offline.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1000,
      },
    });
    let calls = 0;
    const lastUserText: string[] = [];
    session.agent.streamFn = (model, context, options) => {
      calls += 1;
      const users = context.messages.filter((message) => message.role === "user");
      const last = users.at(-1);
      lastUserText.push(
        !last
          ? ""
          : typeof last.content === "string"
            ? last.content
            : last.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      );
      const stream = createAssistantMessageEventStream();
      const base: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
      if (calls === 1) {
        // The first turn streams until the user aborts it.
        stream.push({ type: "start", partial: { ...base, content: [] } });
        const signal = options?.signal;
        const onAbort = () => {
          const aborted: AssistantMessage = { ...base, content: [], stopReason: "aborted" };
          stream.push({ type: "error", reason: "aborted", error: aborted });
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      } else {
        queueMicrotask(() => {
          stream.push({ type: "start", partial: { ...base, content: [] } });
          stream.push({ type: "done", reason: "stop", message: base });
        });
      }
      return stream as unknown as ReturnType<AgentSession["agent"]["streamFn"]>;
    };

    const snapshots: string[][] = [];
    const queue = PromptQueue.attach<Payload>(session, (items) =>
      snapshots.push(items.map(({ id }) => id)),
    );
    if (!queue) throw new Error("pi's queue shape changed; see prompt-queue.ts");
    const consumed: string[] = [];
    const queuedAtFirstAgentEnd: string[][] = [];
    // Same wiring as PiSdkRuntime: consume on message_start, reconcile on agent_end.
    session.subscribe((event) => {
      if (event.type === "message_start") {
        const payload = queue.consume(event.message);
        if (payload) consumed.push(payload.text);
      } else if (event.type === "agent_end") {
        queue.reconcile();
        if (queuedAtFirstAgentEnd.length === 0)
          queuedAtFirstAgentEnd.push(queue.items().map(({ id }) => id));
      }
    });

    const running = session.prompt("start");
    await vi.waitFor(() => expect(session.isStreaming).toBe(true));
    for (const [id, text] of [
      ["a", "follow-up a"],
      ["b", "follow-up b"],
    ] as const) {
      queue.add(item(id, text), { text });
      await queue.deliver(
        id,
        async () => () => session.prompt(text, { streamingBehavior: "followUp" }),
      );
    }
    expect(queue.items().map(({ id }) => id)).toEqual(["a", "b"]);

    await session.abort();
    await running;
    await session.agent.waitForIdle();

    // The aborted run's agent_end kept both: pi still held them.
    expect(queuedAtFirstAgentEnd[0]).toEqual(["a", "b"]);
    // pi then continued with them, each sent exactly once, in order.
    expect(consumed).toEqual(["follow-up a", "follow-up b"]);
    expect(lastUserText.slice(1)).toEqual(["follow-up a", "follow-up b"]);
    // Strip and pi agree at the end: nothing queued anywhere.
    expect(queue.items()).toEqual([]);
    expect(snapshots.at(-1)).toEqual([]);
    expect(session.agent.hasQueuedMessages()).toBe(false);
    expect(session.getFollowUpMessages()).toEqual([]);
    session.dispose();
  });
});
