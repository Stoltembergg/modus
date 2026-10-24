/*
 * PI VERSION PIN: written against @earendil-works/pi-coding-agent 0.80.6
 * (pinned in apps/desktop/package.json). PromptQueue reads and splices pi's
 * PRIVATE fields `agent.steeringQueue.messages` and
 * `agent.followUpQueue.messages`. Upgrading pi therefore requires running
 * `src/main/agent/prompt-queue.test.ts` (including the "real pi session"
 * suites) against the new version before merge.
 */
import type { QueuedPromptItem } from "../../shared/contracts";

/**
 * Modus-side ledger for prompts queued into a streaming pi turn (#271).
 *
 * pi keeps queued steer/follow-up messages in two FIFO queues on its `Agent`
 * and only exposes "clear everything". The visible queue strip needs per-item
 * identity, so every queued prompt gets a stable id here, minted in the main
 * process when the prompt arrives. The id travels to the renderer in
 * `queue.snapshot` events and is the only handle `agent:queue-remove` accepts.
 *
 * Mapping an id to pi's queue is done by object identity, never by position or
 * text: when pi enqueues the message (`agent.steer` / `agent.followUp`) the
 * ledger records the exact message object, and pi's `message_start` for that
 * same object marks it consumed. Removal splices that object out of pi's queue
 * synchronously, so it cannot interleave with pi draining the queue. A message
 * pi already drained (in flight, before its `message_start`) is no longer in
 * the queue; removing it is refused and it is delivered normally.
 *
 * pi's queue arrays are private in its types. The shape is checked once per
 * session; if a pi upgrade changes it, `attach` returns undefined and the
 * runtime falls back to the pre-strip behaviour (message shown in chat at
 * enqueue time, no remove).
 */

type QueueDelivery = QueuedPromptItem["delivery"];

type PendingMessageQueue = { messages: unknown[] };

type QueueAgent = {
  steer(message: unknown): void;
  followUp(message: unknown): void;
  steeringQueue: PendingMessageQueue;
  followUpQueue: PendingMessageQueue;
};

/** The parts of pi's AgentSession the ledger touches. */
export type PromptQueueSession = {
  agent?: unknown;
  getSteeringMessages?: () => readonly string[];
  getFollowUpMessages?: () => readonly string[];
};

type EntryState = "pending" | "capturing" | "queued";

type Entry<P> = {
  item: QueuedPromptItem;
  payload: P;
  state: EntryState;
  message?: object;
  /** Lets the next queued prompt start once this one is in pi's hands. */
  release?: () => void;
};

export type PromptQueueRemoveResult = { removed: boolean };

function isPendingQueue(value: unknown): value is PendingMessageQueue {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

function asQueueAgent(agent: unknown): QueueAgent | undefined {
  if (typeof agent !== "object" || agent === null) return undefined;
  const candidate = agent as Partial<QueueAgent>;
  if (typeof candidate.steer !== "function" || typeof candidate.followUp !== "function") {
    return undefined;
  }
  // pi-agent-core declares these `private readonly`; they are plain fields at runtime.
  if (!isPendingQueue(candidate.steeringQueue) || !isPendingQueue(candidate.followUpQueue)) {
    return undefined;
  }
  return candidate as QueueAgent;
}

/** Same text pi uses to match a user message against its display queues. */
function userMessageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export class PromptQueue<P> {
  private entries: Entry<P>[] = [];
  private capturing: Entry<P> | undefined;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly agent: QueueAgent,
    private readonly session: PromptQueueSession,
    private readonly onChange: (items: QueuedPromptItem[]) => void,
  ) {
    const steer = agent.steer.bind(agent);
    const followUp = agent.followUp.bind(agent);
    agent.steer = (message: unknown) => {
      this.capture("steer", message);
      steer(message);
    };
    agent.followUp = (message: unknown) => {
      this.capture("follow-up", message);
      followUp(message);
    };
  }

  /** Attach a ledger to a pi session, or undefined when pi's queue shape is unknown. */
  static attach<P>(
    session: PromptQueueSession,
    onChange: (items: QueuedPromptItem[]) => void,
  ): PromptQueue<P> | undefined {
    const agent = asQueueAgent(session.agent);
    return agent ? new PromptQueue<P>(agent, session, onChange) : undefined;
  }

  /** Visible queue, in arrival order. */
  items(): QueuedPromptItem[] {
    return this.entries.map((entry) => ({ ...entry.item }));
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.item.id === id);
  }

  /** Show a prompt in the queue the moment it arrives (before pi has it). */
  add(item: QueuedPromptItem, payload: P): void {
    if (this.has(item.id)) throw new Error(`Queued prompt ${item.id} already exists.`);
    this.entries.push({ item: { ...item }, payload, state: "pending" });
    this.notify();
  }

  /**
   * Hand prompt `id` to pi, one prompt at a time in arrival order.
   *
   * `prepare` builds the turn message and returns the call that enqueues it
   * (pi's prompt with a streamingBehavior). The message object pi enqueues is
   * recorded for `id`. The next prompt starts as soon as this one is in pi's
   * hands, even if pi decided to run it as a fresh turn.
   *
   * Returns the payload when the prompt never waited in pi's queue (pi sent it
   * straight away and no `message_start` was seen yet, or an extension handled
   * it) so the caller can show it in chat; undefined when it is queued,
   * removed, or already consumed.
   */
  async deliver(id: string, prepare: () => Promise<() => Promise<void>>): Promise<P | undefined> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.chain;
    this.chain = previous.then(() => turn);
    await previous;
    const entry = this.entries.find((candidate) => candidate.item.id === id);
    try {
      if (entry?.state !== "pending") return undefined;
      let enqueue: () => Promise<void>;
      try {
        enqueue = await prepare();
      } catch (error) {
        this.drop(entry);
        throw error;
      }
      // Removed while its message was being prepared: never reaches pi.
      if (!this.entries.includes(entry)) return undefined;
      entry.state = "capturing";
      entry.release = release;
      this.capturing = entry;
      try {
        await enqueue();
      } catch (error) {
        this.drop(entry);
        throw error;
      } finally {
        if (this.capturing === entry) this.capturing = undefined;
      }
      if (entry.state === "capturing" && this.entries.includes(entry)) {
        this.drop(entry);
        return entry.payload;
      }
      return undefined;
    } finally {
      release();
    }
  }

  /**
   * Remove one queued prompt by id. Refused (removed: false) when pi already
   * took it off the queue to send it, or while it is being handed to pi.
   */
  remove(id: string): PromptQueueRemoveResult {
    const entry = this.entries.find((candidate) => candidate.item.id === id);
    if (!entry) return { removed: false };
    if (entry.state === "capturing") return { removed: false };
    if (entry.state === "queued") {
      const queue =
        entry.item.delivery === "steer" ? this.agent.steeringQueue : this.agent.followUpQueue;
      const index = entry.message ? queue.messages.indexOf(entry.message) : -1;
      if (index === -1) return { removed: false };
      queue.messages.splice(index, 1);
      this.forgetDisplayText(entry);
    }
    this.drop(entry);
    return { removed: true };
  }

  /**
   * pi is about to show a user message (its `message_start`). Returns the
   * payload of the queued prompt that message delivers, if any.
   */
  consume(message: unknown): P | undefined {
    if ((message as { role?: unknown } | undefined)?.role !== "user") return undefined;
    let entry = this.entries.find(
      (candidate) => candidate.state === "queued" && candidate.message === message,
    );
    // pi skipped the queue (the turn ended before the hand-off) and is sending
    // the prompt being delivered right now as a fresh turn.
    if (!entry && this.capturing && !this.capturing.message) entry = this.capturing;
    if (!entry) return undefined;
    // Claimed while pi still runs its prompt() as a fresh turn: let the next
    // queued prompt go, and stop deliver() from reporting it a second time.
    entry.state = "queued";
    entry.release?.();
    this.drop(entry);
    return entry.payload;
  }

  /** After pi's turn ends: forget entries pi no longer holds (nothing to send). */
  reconcile(): void {
    const held = new Set<unknown>([
      ...this.agent.steeringQueue.messages,
      ...this.agent.followUpQueue.messages,
    ]);
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (entry) =>
        entry.state !== "queued" || (entry.message !== undefined && held.has(entry.message)),
    );
    if (this.entries.length !== before) this.notify();
  }

  /**
   * Stop: hand back every prompt still waiting, in arrival order, and forget
   * them. The caller clears pi's own queues; entries not yet handed to pi
   * never reach it (deliver() sees them gone).
   */
  drain(): P[] {
    const payloads = this.entries.map((entry) => entry.payload);
    this.clear();
    return payloads;
  }

  /** Forget everything (session disposed); returns whether anything was shown. */
  clear(): boolean {
    const had = this.entries.length > 0;
    this.entries = [];
    this.capturing = undefined;
    if (had) this.notify();
    return had;
  }

  private capture(delivery: QueueDelivery, message: unknown): void {
    const entry = this.capturing;
    if (!entry || entry.message || entry.item.delivery !== delivery) return;
    if (typeof message !== "object" || message === null) return;
    entry.message = message;
    entry.state = "queued";
    entry.release?.();
  }

  private drop(entry: Entry<P>): void {
    const index = this.entries.indexOf(entry);
    if (index === -1) return;
    this.entries.splice(index, 1);
    this.notify();
  }

  /** Keep pi's own string mirror of the queue in step (it matches by text). */
  private forgetDisplayText(entry: Entry<P>): void {
    const list =
      entry.item.delivery === "steer"
        ? this.session.getSteeringMessages?.()
        : this.session.getFollowUpMessages?.();
    if (!Array.isArray(list) || !entry.message) return;
    const index = (list as string[]).lastIndexOf(userMessageText(entry.message));
    if (index !== -1) (list as string[]).splice(index, 1);
  }

  private notify(): void {
    this.onChange(this.items());
  }
}
