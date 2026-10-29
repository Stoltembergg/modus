import {
  type AgentEventItem,
  appendAgentEvents,
  appendUniqueAgentEvents,
  foldAgentEvents,
  optimisticUserPromptEvents,
  prependAgentEventPage,
} from "../../../../shared/agent-events";
import type { AgentEvent } from "../../../../shared/contracts";

/**
 * Multi-session event plumbing.
 *
 * The app keeps ONE `agent.onEvent` IPC listener; every event is pushed
 * through this hub, which (a) fans the full stream out to the ChatPane for the
 * active session and (b) folds a tiny per-session activity
 * summary (running / needs-input / unread / failed) that powers the sidebar
 * status indicators.
 *
 * Delta accumulation lives in `shared/agent-events` (re-exported here) so the
 * renderer and the main-process event store fold identically.
 */

export {
  type AgentEventItem,
  appendAgentEvents,
  appendUniqueAgentEvents,
  foldAgentEvents,
  optimisticUserPromptEvents,
  prependAgentEventPage,
};

export type SessionActivity = {
  /** A run is currently executing. */
  running: boolean;
  /** A permission request is waiting for the user. */
  needsInput: boolean;
  /** A run finished while the session had no open pane. */
  unread: boolean;
  /** The most recent run ended in failure. */
  failed: boolean;
};

export const IDLE_ACTIVITY: SessionActivity = {
  running: false,
  needsInput: false,
  unread: false,
  failed: false,
};

/**
 * Fold one event into a session's activity summary. `watched` marks sessions
 * that are visible in an open pane — their completions never count as unread.
 * Returns the SAME reference when nothing changed so React state updates can
 * bail out cheaply during token streams.
 */
export function reduceActivity(
  current: SessionActivity | undefined,
  event: AgentEvent,
  watched: boolean,
): SessionActivity {
  const activity = current ?? IDLE_ACTIVITY;
  switch (event.type) {
    case "run.started":
      return { running: true, needsInput: false, unread: false, failed: false };
    case "permission.requested":
      return { ...activity, needsInput: true, unread: watched ? activity.unread : true };
    case "permission.resolved":
      return activity.needsInput ? { ...activity, needsInput: false } : activity;
    case "run.completed":
      return {
        running: false,
        needsInput: false,
        unread: !watched,
        failed: false,
      };
    case "run.failed":
      return {
        running: false,
        needsInput: false,
        unread: !watched,
        failed: true,
      };
    case "run.cancelled":
    case "run.blocked":
      return { ...activity, running: false, needsInput: false };
    default:
      return activity;
  }
}

/** True when the event should trigger an activity re-render at all. */
export function affectsActivity(event: AgentEvent): boolean {
  switch (event.type) {
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "run.blocked":
    case "permission.requested":
    case "permission.resolved":
      return true;
    default:
      return false;
  }
}

type Subscriber = (item: AgentEventItem) => void;
type HistorySubscriber = (items: AgentEventItem[]) => void;

/**
 * Per-session fanout. Multiple panes may subscribe to the same session (the
 * same conversation opened twice stays in sync because both receive the
 * stream); sessions without subscribers cost a single Map lookup per event.
 */
export class AgentEventHub {
  private subscribers = new Map<string, Set<Subscriber>>();
  private prepared = new Map<string, AgentEventItem[]>();
  private historyBySession = new Map<string, AgentEventItem[]>();
  private pendingHistoryBySession = new Map<string, AgentEventItem[]>();
  private historyFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private historySubscribers = new Map<string, Set<HistorySubscriber>>();

  getHistory(sessionId: string): AgentEventItem[] {
    const history = this.historyBySession.get(sessionId) ?? [];
    const pending = this.pendingHistoryBySession.get(sessionId) ?? [];
    return pending.length > 0 ? foldAgentEvents([...history, ...pending]) : [...history];
  }

  /** Seed persisted events, then retain any newer events streamed during the fetch. */
  seedHistory(sessionId: string, items: AgentEventItem[], snapshotCursor?: number): void {
    this.flushHistory(sessionId, false);
    if (items.length === 0 && snapshotCursor === undefined) {
      this.notifyHistory(sessionId);
      return;
    }
    const current = this.historyBySession.get(sessionId) ?? [];
    let seededThrough = Number.NEGATIVE_INFINITY;
    for (const item of items) {
      const timestamp = Date.parse(item.updatedAt ?? item.createdAt ?? "");
      if (Number.isFinite(timestamp)) seededThrough = Math.max(seededThrough, timestamp);
    }
    const currentById = new Map(current.map((item) => [item.id, item]));
    const mergedSeed = items.map((item) => {
      const live = currentById.get(item.id);
      if (!live) return item;
      const persistedAt = Date.parse(item.updatedAt ?? item.createdAt ?? "");
      const liveAt = Date.parse(live.updatedAt ?? live.createdAt ?? "");
      return !Number.isFinite(persistedAt) || liveAt >= persistedAt ? live : item;
    });
    const seededIds = new Set(mergedSeed.map((item) => item.id));
    const newerLiveItems = current.filter((item) => {
      if (seededIds.has(item.id)) return false;
      const cursor = (item.event as AgentEvent & { eventCursor?: number }).eventCursor;
      if (snapshotCursor !== undefined && cursor !== undefined) return cursor > snapshotCursor;
      if (item.optimistic) return true;
      const timestamp = Date.parse(item.updatedAt ?? item.createdAt ?? "");
      return !Number.isFinite(timestamp) || timestamp >= seededThrough;
    });
    this.historyBySession.set(sessionId, foldAgentEvents([...mergedSeed, ...newerLiveItems]));
    this.notifyHistory(sessionId);
  }

  subscribeHistory(sessionId: string, subscriber: HistorySubscriber): () => void {
    const set = this.historySubscribers.get(sessionId) ?? new Set<HistorySubscriber>();
    set.add(subscriber);
    this.historySubscribers.set(sessionId, set);
    subscriber(this.getHistory(sessionId));
    if ((this.pendingHistoryBySession.get(sessionId)?.length ?? 0) > 0) {
      this.scheduleHistoryFlush(sessionId);
    }
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.historySubscribers.delete(sessionId);
      this.releaseInactiveHistory(sessionId);
    };
  }

  private notifyHistory(sessionId: string): void {
    const history = this.getHistory(sessionId);
    for (const subscriber of this.historySubscribers.get(sessionId) ?? []) {
      subscriber(history);
    }
  }

  private scheduleHistoryFlush(sessionId: string): void {
    if (this.historyFlushTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.historyFlushTimers.delete(sessionId);
      this.flushHistory(sessionId);
    }, 16);
    this.historyFlushTimers.set(sessionId, timer);
  }

  private flushHistory(sessionId: string, notify = true): void {
    const timer = this.historyFlushTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.historyFlushTimers.delete(sessionId);
    }
    const pending = this.pendingHistoryBySession.get(sessionId);
    if (pending?.length) {
      this.historyBySession.set(
        sessionId,
        appendAgentEvents(this.historyBySession.get(sessionId) ?? [], pending),
      );
      this.pendingHistoryBySession.delete(sessionId);
    }
    if (notify && this.historySubscribers.has(sessionId)) this.notifyHistory(sessionId);
    if (notify) this.releaseInactiveHistory(sessionId);
  }

  private releaseInactiveHistory(sessionId: string): void {
    if (
      (this.subscribers.get(sessionId)?.size ?? 0) > 0 ||
      (this.historySubscribers.get(sessionId)?.size ?? 0) > 0 ||
      this.prepared.has(sessionId)
    ) {
      return;
    }
    const pending = this.pendingHistoryBySession.get(sessionId);
    const timer = this.historyFlushTimers.get(sessionId);
    // Keep events only for the short pending-to-subscriber handoff window.
    // Persisted events are reloaded from the durable page API, while the
    // explicit `prepared` map protects prompts dispatched before a pane mounts.
    if (pending?.length && timer !== undefined) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      this.historyFlushTimers.delete(sessionId);
    }
    this.pendingHistoryBySession.delete(sessionId);
    this.historyBySession.delete(sessionId);
  }

  prepare(sessionId: string): void {
    if (!this.subscribers.has(sessionId) && !this.prepared.has(sessionId)) {
      this.prepared.set(sessionId, []);
    }
  }

  cancelPrepare(sessionId: string): void {
    this.prepared.delete(sessionId);
    this.releaseInactiveHistory(sessionId);
  }

  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(sessionId, set);
    const prepared = this.prepared.get(sessionId);
    this.prepared.delete(sessionId);
    for (const item of prepared ?? []) {
      subscriber(item);
    }
    return () => {
      set.delete(subscriber);
      if (set.size === 0) {
        this.subscribers.delete(sessionId);
      }
      this.releaseInactiveHistory(sessionId);
    };
  }

  publish(item: AgentEventItem): void {
    const pendingHistory = this.pendingHistoryBySession.get(item.event.sessionId) ?? [];
    pendingHistory.push(item);
    this.pendingHistoryBySession.set(item.event.sessionId, pendingHistory);
    this.scheduleHistoryFlush(item.event.sessionId);
    const set = this.subscribers.get(item.event.sessionId);
    if (!set) {
      this.prepared.get(item.event.sessionId)?.push(item);
      return;
    }
    for (const subscriber of set) {
      subscriber(item);
    }
  }

  hasSubscribers(sessionId: string): boolean {
    return (this.subscribers.get(sessionId)?.size ?? 0) > 0;
  }
}
