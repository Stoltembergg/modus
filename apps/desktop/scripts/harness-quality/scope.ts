import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const QUALITY_TOOL_NAMES = ["read", "edit", "write", "task", "wait", "todo_write"] as const;

/** All fixture files are pre-created. No mkdir, shell, glob expansion or symlink traversal. */
export function fixtureFilePath(
  root: string,
  path: unknown,
  declaredFiles: readonly string[],
): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return undefined;
  const target = resolve(root, path);
  const name = relative(root, target);
  if (
    isAbsolute(name) ||
    name === ".." ||
    name.startsWith(`..${sep}`) ||
    !declaredFiles.includes(name)
  )
    return undefined;
  try {
    if (realpathSync(root) !== resolve(root)) return undefined;
    let cursor = root;
    for (const part of name.split(sep)) {
      cursor = resolve(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) return undefined;
    }
    if (!lstatSync(target).isFile() || realpathSync(target) !== target) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

export function fixtureToolDecision(input: {
  toolName: string;
  args: unknown;
  root: string;
  files: readonly string[];
  writable: readonly string[];
  selectedModel: string;
  delegationAllowed: boolean;
  tasksStarted: number;
}): { block: true; reason: string } | undefined {
  const deny = () => ({
    block: true as const,
    reason: "Quality evaluation fixture scope denied this call.",
  });
  if (!input.args || typeof input.args !== "object" || Array.isArray(input.args)) return deny();
  const args = input.args as Record<string, unknown>;
  try {
    if (JSON.stringify(args).length > 128 * 1024) return deny();
  } catch {
    return deny();
  }
  if (["read", "edit", "write"].includes(input.toolName)) {
    const allowed = input.toolName === "read" ? input.files : input.writable;
    return fixtureFilePath(input.root, args.path, allowed) ? undefined : deny();
  }
  if (input.toolName === "wait" || input.toolName === "todo_write") return undefined;
  if (input.toolName === "task") {
    if (!input.delegationAllowed || input.tasksStarted >= 1 || args.subagent !== "explore")
      return deny();
    if (args.model !== undefined && args.model !== "inherit" && args.model !== input.selectedModel)
      return deny();
    return undefined;
  }
  return deny();
}
