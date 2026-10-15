const ORDER_KEY = "modus.sidebar.sessionOrder";

/** Presentation only. Workspace, cwd and pinning remain authoritative in the host. */
export function readSessionOrder(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string"))].slice(0, 10000)
      : [];
  } catch {
    return [];
  }
}

export function writeSessionOrder(ids: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids.slice(0, 10000)));
  } catch {
    // A disabled/full localStorage must not prevent an authoritative workspace move.
  }
}

export function orderSessions<T extends { id: string }>(sessions: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return sessions.toSorted((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1));
}

export function moveSessionBefore(ids: string[], source: string, before?: string): string[] {
  if (source === before || !ids.includes(source)) return ids;
  const next = ids.filter((id) => id !== source);
  const index = before ? next.indexOf(before) : -1;
  next.splice(index < 0 ? next.length : index, 0, source);
  return next;
}
