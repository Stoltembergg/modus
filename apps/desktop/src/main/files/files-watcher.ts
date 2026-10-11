import { type FSWatcher, watch } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { BrowserWindow } from "electron";
import type { FilesChangeEvent } from "../../shared/contracts";
import { notifyGroupProjectPathsChanged } from "../groups/group-project-setup";
import { IPC_CHANNELS } from "../ipc/channels";

/**
 * Live workspace refresh for the Files panel. Watches a workspace root,
 * debounces filesystem bursts, and broadcasts `files:event` so the renderer
 * can refresh the tree and open buffer. Policy: when the open file changes on
 * disk (agent / external editor), disk wins — the renderer overwrites any
 * unsaved local draft.
 */

const DEBOUNCE_MS = 300;

type WatchEntry = {
  refCount: number;
  watcher: FSWatcher | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Absolute paths coalesced in the current burst (empty ⇒ full refresh). */
  pendingPaths: Set<string>;
  root: string;
};

const entries = new Map<string, WatchEntry>();

export function emitFilesEvent(event: FilesChangeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.filesEvent, event);
    }
  }
  // Incremental Agent Groups project Setup (selective invalidate via fingerprint).
  notifyGroupProjectPathsChanged(event.cwd, event.paths ?? []);
}

/**
 * Drop high-churn trees that are not useful for the explorer UI. This is
 * operational noise filtering, not behavior routed by tool / filename kind.
 */
function isNoise(absPath: string, root: string): boolean {
  const rel = relative(root, absPath);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
    return true;
  }
  return rel.split(sep).some((part) => part === "node_modules" || part === ".git");
}

function scheduleFlush(entry: WatchEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    const paths = [...entry.pendingPaths];
    entry.pendingPaths.clear();
    emitFilesEvent({ cwd: entry.root, paths });
  }, DEBOUNCE_MS);
}

function emitWatcherUnavailable(root: string): void {
  emitFilesEvent({ cwd: root, paths: [], watching: false });
}

function startWatcher(entry: WatchEntry): void {
  if (entry.watcher) return;
  try {
    const watcher = watch(entry.root, { recursive: true }, (_event, filename) => {
      const name =
        typeof filename === "string" ? filename : filename == null ? undefined : String(filename);
      if (name) {
        const abs = join(entry.root, name);
        if (isNoise(abs, entry.root)) {
          return;
        }
        entry.pendingPaths.add(abs);
      }
      // Missing filename (some platforms) ⇒ flush with empty paths = full refresh.
      scheduleFlush(entry);
    });
    entry.watcher = watcher;
    watcher.on("error", () => {
      if (entry.watcher !== watcher) return;
      entry.watcher = undefined;
      try {
        watcher.close();
      } catch {
        // already closed
      }
      emitWatcherUnavailable(entry.root);
    });
  } catch {
    // Snapshot-only consumers remain usable; verification consumers fail closed.
    entry.watcher = undefined;
  }
}

/** Begin watching `cwd` (ref-counted). Returns the resolved absolute root. */
export function watchWorkspace(cwd: string): string {
  const root = resolve(cwd);
  const existing = entries.get(root);
  if (existing) {
    existing.refCount += 1;
    startWatcher(existing);
    return root;
  }

  const entry: WatchEntry = {
    refCount: 1,
    watcher: undefined,
    timer: undefined,
    pendingPaths: new Set(),
    root,
  };

  entries.set(root, entry);
  startWatcher(entry);
  return root;
}

/** Return whether this workspace still has an active filesystem watcher. */
export function isWorkspaceWatched(cwd: string): boolean {
  return entries.get(resolve(cwd))?.watcher !== undefined;
}

/** Stop watching (ref-counted). Closes the watcher when the last subscriber leaves. */
export function unwatchWorkspace(cwd: string): void {
  const root = resolve(cwd);
  const entry = entries.get(root);
  if (!entry) {
    return;
  }

  entry.refCount -= 1;
  if (entry.refCount > 0) {
    return;
  }

  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  try {
    entry.watcher?.close();
  } catch {
    // already closed
  }
  entries.delete(root);
}
