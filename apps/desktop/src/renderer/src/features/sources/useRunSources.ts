import { useEffect, useState } from "react";
import type { AgentEventItem } from "../agent/agentEventHub";
import { collectRunSources, type RunSource } from "./runSources";

const EVENT_CACHE_MS = 2_000;
const recentEvents = new Map<string, { expiresAt: number; items: AgentEventItem[] }>();
const pendingEvents = new Map<string, Promise<AgentEventItem[]>>();

async function loadSessionEvents(sessionId: string): Promise<AgentEventItem[]> {
  const cached = recentEvents.get(sessionId);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  const pending = pendingEvents.get(sessionId);
  if (pending) return pending;

  const request = window.modus.agent.listEvents(sessionId).then((items: AgentEventItem[]) => {
    const events = items as AgentEventItem[];
    recentEvents.set(sessionId, { expiresAt: Date.now() + EVENT_CACHE_MS, items: events });
    return events;
  });
  pendingEvents.set(sessionId, request);
  try {
    return await request;
  } finally {
    pendingEvents.delete(sessionId);
  }
}

/** Loads a completed group member run without making its work transcript content. */
export function useRunSources(
  sessionId: string | undefined,
  runId: string | undefined,
  enabled: boolean,
): RunSource[] {
  const [sources, setSources] = useState<RunSource[]>([]);
  useEffect(() => {
    let cancelled = false;
    setSources([]);
    if (!sessionId || !runId || !enabled || !window.modus?.agent?.listEvents) return;
    void loadSessionEvents(sessionId)
      .then((items) => {
        if (!cancelled) setSources(collectRunSources(items, runId));
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, runId, sessionId]);
  return sources;
}
