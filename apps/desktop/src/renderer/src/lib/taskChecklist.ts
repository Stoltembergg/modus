import { useSyncExternalStore } from "react";

/**
 * Whether the task checklist (the agent's `todo_write` plan, rendered by TodosCard) is shown.
 * Toggled from the session top bar; persisted in localStorage so it survives restarts.
 * Default: shown.
 */
export const TASK_CHECKLIST_STORAGE_KEY = "modus.taskChecklist.visible";

function readStored(): boolean {
  try {
    return localStorage.getItem(TASK_CHECKLIST_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

let visible = readStored();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVisible(): boolean {
  return visible;
}

export function setTaskChecklistVisible(next: boolean): void {
  visible = next;
  try {
    localStorage.setItem(TASK_CHECKLIST_STORAGE_KEY, String(next));
  } catch {
    // Storage unavailable: keep the in-memory value for this session.
  }
  for (const listener of listeners) listener();
}

export function toggleTaskChecklist(): void {
  setTaskChecklistVisible(!visible);
}

/** Test-only: re-read the persisted value (e.g. after seeding localStorage). */
export function reloadTaskChecklistPreference(): void {
  visible = readStored();
  for (const listener of listeners) listener();
}

export function useTaskChecklistVisible(): boolean {
  return useSyncExternalStore(subscribe, getVisible, getVisible);
}
