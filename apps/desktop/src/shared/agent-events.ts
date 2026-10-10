import { buildContextChips } from "./context-chips";
import type { AgentEvent, ContextItem, MessageContextChip } from "./contracts";

export type AgentEventItem = {
  id: string;
  event: AgentEvent;
  createdAt?: string;
  /** Last streamed chunk time for folded deltas (thinking / message / tool). */
  updatedAt?: string;
  /** Cursor span of folded deltas, used to suppress live/persisted overlap in constant space. */
  sourceCursorRange?: { first: number; last: number };
  optimistic?: boolean;
};

export const MAX_AGENT_EVENT_PAGE_SIZE = 256;

export type AgentEventPage = {
  events: Array<AgentEventItem & { createdAt: string }>;
  /** Bounded latest state needed for session controls that must outlive the visible page. */
  summaryEvents: Array<AgentEventItem & { createdAt: string }>;
  /** Bounded suffix for Agent Group working/activity summaries. */
  activityEvents: Array<AgentEventItem & { createdAt: string }>;
  snapshotCursor: number;
  /** Continuation cursor: last event for forward pages, first event for backward pages. */
  nextCursor?: number;
  hasMore: boolean;
};

export type AgentEventPageOptions =
  | {
      direction?: "forward" | undefined;
      afterCursor?: number | undefined;
      snapshotCursor?: number | undefined;
      limit?: number | undefined;
      /** Return only tool activity inside this session's exact run boundary. */
      runId?: string | undefined;
      includeSummary?: boolean | undefined;
      includeActivity?: boolean | undefined;
    }
  | {
      direction: "backward";
      beforeCursor?: number | undefined;
      snapshotCursor?: number | undefined;
      limit?: number | undefined;
      includeSummary?: boolean | undefined;
      includeActivity?: boolean | undefined;
    };

/**
 * Fold key = the event's own authoritative stream identity.
 *
 * Streamed deltas of one logical part (a message's text, a message's thinking,
 * a tool call's output, a tool call's live args) all carry the id that part was
 * opened with — `messageId` or `toolCallId`. We key the fold on that id, never
 * on array position. So interleaved streams (thinking → text → tool → thinking)
 * still collapse correctly, and a session's event list stays O(parts) instead
 * of O(deltas): one accumulated item per stream, not one per chunk.
 *
 * Durable lifecycle events are keyed when the event identity is explicit
 * (`messageId`, session id for status), so local optimistic items can be
 * replaced by the runtime's authoritative echo.
 */
function foldKey(event: AgentEvent): string | undefined {
  if ("runId" in event && typeof event.runId === "string") {
    return `${event.type}:${event.runId}`;
  }
  switch (event.type) {
    case "message.started":
    case "message.completed":
      return `${event.type}:${event.messageId}`;
    case "message.delta":
    case "thinking.delta":
      return `${event.type}:${event.messageId}`;
    case "tool.output":
    case "tool.delta":
      return `${event.type}:${event.toolCallId}`;
    case "session.status":
      return `${event.type}:${event.sessionId}`;
    default:
      return undefined;
  }
}

function eventCursor(item: AgentEventItem): number | undefined {
  const cursor = (item.event as AgentEvent & { eventCursor?: number }).eventCursor;
  return Number.isSafeInteger(cursor) && cursor !== undefined ? cursor : undefined;
}

function cursorRange(item: AgentEventItem): { first: number; last: number } | undefined {
  if (item.sourceCursorRange) return item.sourceCursorRange;
  const cursor = eventCursor(item);
  return cursor === undefined ? undefined : { first: cursor, last: cursor };
}

/**
 * Accumulate `next` into the matching `previous` item. The accumulation rule is
 * a property of the field, not the tool/message identity: text-bearing deltas
 * concatenate their growing field; a `tool.delta` carries the full args-so-far,
 * so the latest simply wins. `foldKey` guarantees both share the same type.
 */
function foldInto<T extends AgentEventItem>(previous: T, next: T): T {
  if (previous.optimistic && !next.optimistic) {
    return next;
  }
  if (!previous.optimistic && next.optimistic) {
    return previous;
  }
  const prev = previous.event;
  const cur = next.event;
  const previousRange = cursorRange(previous);
  const nextRange = cursorRange(next);
  const sourceCursorRange =
    previousRange && nextRange
      ? {
          first: Math.min(previousRange.first, nextRange.first),
          last: Math.max(previousRange.last, nextRange.last),
        }
      : (previousRange ?? nextRange);
  const withEnd = (item: T): T =>
    ({
      ...item,
      ...(sourceCursorRange ? { sourceCursorRange } : {}),
      ...(next.createdAt !== undefined ? { updatedAt: next.createdAt } : {}),
    }) as T;
  const isAccumulatedText =
    (prev.type === "message.delta" && cur.type === "message.delta") ||
    (prev.type === "thinking.delta" && cur.type === "thinking.delta") ||
    (prev.type === "tool.output" && cur.type === "tool.output");
  if (isAccumulatedText && previousRange && nextRange) {
    const nextContainsPrevious =
      nextRange.first <= previousRange.first && nextRange.last >= previousRange.last;
    if (nextContainsPrevious) return withEnd(next);
    const previousContainsNext =
      previousRange.first <= nextRange.first && previousRange.last >= nextRange.last;
    if (previousContainsNext) return withEnd(previous);
  }
  if (prev.type === "message.delta" && cur.type === "message.delta") {
    return withEnd({ ...previous, event: { ...prev, ...cur, delta: prev.delta + cur.delta } } as T);
  }
  if (prev.type === "thinking.delta" && cur.type === "thinking.delta") {
    return withEnd({ ...previous, event: { ...prev, ...cur, delta: prev.delta + cur.delta } } as T);
  }
  if (prev.type === "tool.output" && cur.type === "tool.output") {
    return withEnd({
      ...previous,
      event: { ...prev, ...cur, output: prev.output + cur.output },
    } as T);
  }
  return next;
}

/**
 * Append freshly streamed items onto an event list, folding each delta into its
 * stream's single accumulated item (keyed by the part id the event carries).
 * Only the folded item gets a new reference, so React state updates stay cheap.
 * Cost is O(existing parts + new items): the index is rebuilt from the already
 * folded list, which is bounded by part count, not chunk count.
 */
export function appendAgentEvents<T extends AgentEventItem>(events: T[], nextItems: T[]): T[] {
  const accumulator = createAgentEventAccumulator(events);
  accumulator.append(nextItems);
  return accumulator.items();
}

/** Append event echoes only once when a live stream overlaps a persisted page fetch. */
export function appendUniqueAgentEvents<T extends AgentEventItem>(
  events: T[],
  nextItems: T[],
): T[] {
  const knownIds = new Set(events.map((item) => item.id));
  const rangesByKey = new Map<string, Array<{ first: number; last: number }>>();
  for (const item of events) {
    const key = foldKey(item.event);
    const range = cursorRange(item);
    if (!key || !range) continue;
    const ranges = rangesByKey.get(key) ?? [];
    ranges.push(range);
    rangesByKey.set(key, ranges);
  }
  const uniqueItems = nextItems.filter((item) => {
    if (knownIds.has(item.id)) return false;
    knownIds.add(item.id);
    const key = foldKey(item.event);
    const cursor = eventCursor(item);
    return !(
      key &&
      cursor !== undefined &&
      rangesByKey.get(key)?.some((range) => cursor >= range.first && cursor <= range.last)
    );
  });
  return appendAgentEvents(events, uniqueItems);
}

/** Prepend one older raw page, then fold deltas across the page boundary. */
export function prependAgentEventPage<T extends AgentEventItem>(current: T[], older: T[]): T[] {
  const currentIds = new Set(current.map((item) => item.id));
  const currentRanges = new Map<string, Array<{ first: number; last: number }>>();
  for (const item of current) {
    const key = foldKey(item.event);
    const range = cursorRange(item);
    if (!key || !range) continue;
    const ranges = currentRanges.get(key) ?? [];
    ranges.push(range);
    currentRanges.set(key, ranges);
  }
  return foldAgentEvents([
    ...older.filter((item) => {
      if (currentIds.has(item.id)) return false;
      const key = foldKey(item.event);
      const cursor = eventCursor(item);
      return !(
        key &&
        cursor !== undefined &&
        currentRanges.get(key)?.some((range) => cursor >= range.first && cursor <= range.last)
      );
    }),
    ...current,
  ]);
}

/** Fold pages into one history without rebuilding the event index per page. */
export function createAgentEventAccumulator<T extends AgentEventItem>(initial: readonly T[] = []) {
  const result = [...initial];
  const indexByKey = new Map<string, number>();
  result.forEach((entry, i) => {
    const key = foldKey(entry.event);
    if (key !== undefined) {
      indexByKey.set(key, i);
    }
  });
  return {
    append(nextItems: readonly T[]): void {
      for (const item of nextItems) {
        const key = foldKey(item.event);
        if (key !== undefined) {
          const at = indexByKey.get(key);
          const existing = at === undefined ? undefined : result[at];
          if (at !== undefined && existing !== undefined) {
            result[at] = foldInto(existing, item);
            continue;
          }
          indexByKey.set(key, result.length);
        }
        result.push(item);
      }
    },
    items(): T[] {
      return result;
    },
  };
}

/** Fold a complete event list (e.g. a session's persisted history) in one pass. */
export function foldAgentEvents<T extends AgentEventItem>(items: T[]): Array<T & AgentEventItem> {
  return appendAgentEvents([], items);
}

export function optimisticUserPromptEvents(input: {
  sessionId: string;
  userMessageId: string;
  message: string;
  attachments?: Extract<AgentEvent, { type: "message.started" }>["attachments"];
  skills?: Extract<AgentEvent, { type: "message.started" }>["skills"];
  contextItems?: ContextItem[];
  contextChips?: MessageContextChip[];
}): AgentEventItem[] {
  const createdAt = new Date().toISOString();
  const contextChips =
    input.contextChips ??
    (input.contextItems && input.contextItems.length > 0
      ? buildContextChips(input.contextItems)
      : undefined);
  const started: Extract<AgentEvent, { type: "message.started" }> = {
    type: "message.started",
    sessionId: input.sessionId,
    messageId: input.userMessageId,
    role: "user",
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
    ...(input.contextItems && input.contextItems.length > 0
      ? { contextItems: input.contextItems }
      : {}),
    ...(contextChips && contextChips.length > 0 ? { contextChips } : {}),
  };
  return [
    {
      id: `optimistic:${input.userMessageId}:started`,
      event: started,
      createdAt,
      optimistic: true,
    },
    {
      id: `optimistic:${input.userMessageId}:delta`,
      event: {
        type: "message.delta",
        sessionId: input.sessionId,
        messageId: input.userMessageId,
        delta: input.message,
      },
      createdAt,
      optimistic: true,
    },
    {
      id: `optimistic:${input.userMessageId}:completed`,
      event: {
        type: "message.completed",
        sessionId: input.sessionId,
        messageId: input.userMessageId,
      },
      createdAt,
      optimistic: true,
    },
    {
      id: `optimistic:${input.sessionId}:status`,
      event: { type: "session.status", sessionId: input.sessionId, status: { type: "busy" } },
      createdAt,
      optimistic: true,
    },
  ];
}
