import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { ContextItem } from "../../shared/contracts";
import { finalizeProjectMemoryRun } from "../memory/project-memory-service";

export const MAX_PROJECT_MEMORY_CONTEXT_HINTS = 32;

export function finalizeProjectMemoryRunBestEffort(input: {
  sessionId: string;
  runId: string;
  outcome: "completed" | "failed" | "cancelled";
}): void {
  try {
    finalizeProjectMemoryRun(input);
  } catch {
    // Agent run status/events are authoritative; optional memory persistence cannot change them.
    console.warn("[modus] Project Memory run finalization failed.");
  }
}

export function projectMemoryHints(
  items: ContextItem[] | undefined,
  cwd: string,
): { paths: string[]; symbols: string[] } {
  const paths = new Set<string>();
  const symbols = new Set<string>();
  const addPath = (path: string | undefined): void => {
    if (!path || paths.size >= MAX_PROJECT_MEMORY_CONTEXT_HINTS) return;
    const absolute =
      isAbsolute(path) || win32.isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    const relativePath = relative(cwd, absolute);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return;
    paths.add(relativePath.split(sep).join("/"));
  };
  for (const item of items ?? []) {
    if (item.type === "file" || item.type === "folder" || item.type === "excerpt") {
      addPath(item.path);
    } else if (item.type === "design-element") {
      addPath(item.element.source?.file);
      if (item.element.componentName && symbols.size < MAX_PROJECT_MEMORY_CONTEXT_HINTS) {
        symbols.add(item.element.componentName);
      }
    }
  }
  return { paths: [...paths], symbols: [...symbols] };
}
