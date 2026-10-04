import type { ToolCallEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PermissionAction } from "../../../shared/contracts";
import {
  BUILTIN_TOOL_CATALOG,
  GROUP_MEMBER_TOOL_NAMES,
  type ToolCapability,
  type ToolCatalogEntry,
  type ToolProfileName,
} from "../../../shared/tools";
import { recognizeCheckInvocation } from "../harness/qa-evidence";

/**
 * Runtime tool registry. Wraps the shared catalog with PI-SDK-dependent behavior:
 * dynamic permission classification and custom-tool registration. Built-in tools
 * come from the shared catalog; custom tools are registered at runtime and flow
 * through the same activation/permission/UI pipeline.
 */

export type ToolClassification = {
  action: PermissionAction;
  dangerous: boolean;
};

export type ToolClassifier = (event: ToolCallEvent) => ToolClassification;

/** Per-session adjustments layered on top of a profile's default active set. */
export type ToolOverrides = {
  enable?: string[];
  disable?: string[];
};

const WRITE_CAPABILITIES = new Set<ToolCapability>(["write", "shell", "process"]);

export type RegisterToolInput = {
  /** Catalog metadata; `kind` is forced to "custom". */
  entry: Omit<ToolCatalogEntry, "kind">;
  /** The PI tool definition handed to `createAgentSession({ customTools })`. */
  definition: ToolDefinition;
  /** Optional dynamic permission classifier (for tools whose risk depends on args). */
  classify?: ToolClassifier;
};

const DEFAULT_ACTION: PermissionAction = "mcp.call";

/** Primary target string for a tool call (command, path, else the raw input). */
export function getToolTarget(event: ToolCallEvent): string {
  if ((GROUP_MEMBER_TOOL_NAMES as readonly string[]).includes(event.toolName)) {
    const input = event.input as Record<string, unknown>;
    const taskId = input.taskId ?? input.id;
    if (typeof taskId === "string") return taskId;
  }
  if ("command" in event.input && typeof event.input.command === "string") {
    return event.input.command;
  }
  if ("path" in event.input && typeof event.input.path === "string") {
    return event.input.path;
  }
  return JSON.stringify(event.input);
}

function isGitWriteCommand(command: string): boolean {
  return /\bgit\s+(commit|push|reset|clean|checkout\s+--|restore\b|branch\s+-D|worktree\s+remove|stash\s+(drop|clear))\b/i.test(
    command,
  );
}

function isMutatingShellCommand(command: string): boolean {
  return /\b(rm|mv|touch|chmod|chown)\b|(^|\s)(>|>>|<<)\s*|\b(npm|pnpm|yarn)\s+(i|install|add)\b/i.test(
    command,
  );
}

function isUnresolvedPackageManagerCheckCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const packageManager = tokens[0]?.toLowerCase();
  if (packageManager !== "npm" && packageManager !== "pnpm" && packageManager !== "yarn") {
    return false;
  }
  let cursor = 1;
  if (packageManager === "yarn" && tokens[cursor]?.toLowerCase() === "workspace") {
    if (!tokens[cursor + 1]) return false;
    cursor += 2;
  } else if (packageManager !== "yarn") {
    while (cursor < tokens.length) {
      const option = tokens[cursor]?.toLowerCase();
      const workspaceOption =
        option === "--workspace" ||
        option === "-w" ||
        (packageManager === "pnpm" && (option === "--filter" || option === "-f"));
      if (workspaceOption) {
        if (!tokens[cursor + 1]) return false;
        cursor += 2;
        continue;
      }
      if (
        option?.startsWith("--workspace=") ||
        option?.startsWith("-w=") ||
        (packageManager === "pnpm" && option?.startsWith("--filter=")) ||
        (packageManager === "pnpm" && option?.startsWith("-f="))
      ) {
        cursor += 1;
        continue;
      }
      break;
    }
  }
  if (tokens[cursor]?.toLowerCase() === "run") cursor += 1;
  const scriptName = tokens[cursor]?.replace(/[;&|]+$/, "").toLowerCase();
  return ["test", "typecheck", "lint", "build"].includes(scriptName ?? "");
}

function isExpandedCheckCommand(command: string): boolean {
  if (!/[$`*?[\]{}()~;&|<>]/.test(command)) return false;
  return /^(?:npx\s+)?(?:vitest|jest|mocha|tsc|eslint|biome|vite)\b/i.test(command.trimStart());
}

/**
 * Risk verdict for a raw shell command string. Shared by the built-in `bash`
 * tool and the custom `terminal_run` tool so both gate dangerous commands the
 * same way: git-write and mutating commands prompt; everything else runs.
 */
export function classifyShellCommand(command: string): ToolClassification {
  if (isGitWriteCommand(command)) {
    return { action: "git.write", dangerous: true };
  }
  if (
    recognizeCheckInvocation("bash", command) ||
    isUnresolvedPackageManagerCheckCommand(command) ||
    isExpandedCheckCommand(command)
  ) {
    return { action: "shell.execute", dangerous: true };
  }
  return { action: "shell.execute", dangerous: isMutatingShellCommand(command) };
}

/** Built-in bash classifier: only git-write / mutating commands require approval. */
const bashClassifier: ToolClassifier = (event) => classifyShellCommand(getToolTarget(event));

export class ToolRegistry {
  private readonly entries = new Map<string, ToolCatalogEntry>();
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly classifiers = new Map<string, ToolClassifier>();
  private customToolsRevision = 0;

  /** Changes whenever custom registration changes, including same-name replacements. */
  get revision(): number {
    return this.customToolsRevision;
  }

  constructor(builtins: ToolCatalogEntry[] = BUILTIN_TOOL_CATALOG) {
    for (const entry of builtins) {
      this.entries.set(entry.name, entry);
    }
    this.classifiers.set("bash", bashClassifier);
  }

  /** Register a custom LLM-callable tool. It joins the activation/permission/UI pipeline. */
  registerTool(input: RegisterToolInput): void {
    const entry: ToolCatalogEntry = { ...input.entry, kind: "custom" };
    this.entries.set(entry.name, entry);
    this.definitions.set(entry.name, input.definition);
    if (input.classify) {
      this.classifiers.set(entry.name, input.classify);
    }
    this.customToolsRevision += 1;
  }

  /** Remove a previously registered custom tool (no-op for builtins/unknown). */
  unregisterTool(name: string): void {
    if (this.entries.get(name)?.kind !== "custom") {
      return;
    }
    this.entries.delete(name);
    this.definitions.delete(name);
    this.classifiers.delete(name);
    this.customToolsRevision += 1;
  }

  /** Active tool names for a profile → `createAgentSession({ tools })`. */
  resolveActiveTools(profile: ToolProfileName, overrides?: ToolOverrides): string[] {
    const active = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.profiles.includes(profile)) {
        active.add(entry.name);
      }
    }
    for (const name of overrides?.enable ?? []) {
      active.add(name);
    }
    for (const name of overrides?.disable ?? []) {
      active.delete(name);
    }
    return [...active];
  }

  /** Custom tool definitions active for a profile → `createAgentSession({ customTools })`. */
  getCustomToolDefinitions(profile: ToolProfileName, overrides?: ToolOverrides): ToolDefinition[] {
    const active = new Set(this.resolveActiveTools(profile, overrides));
    const definitions: ToolDefinition[] = [];
    for (const [name, definition] of this.definitions) {
      if (active.has(name)) {
        definitions.push(definition);
      }
    }
    return definitions;
  }

  /** Decide whether a tool call needs approval and under which permission action. */
  classify(event: ToolCallEvent): ToolClassification {
    const classifier = this.classifiers.get(event.toolName);
    if (classifier) {
      return classifier(event);
    }
    const entry = this.entries.get(event.toolName);
    if (entry) {
      return {
        action: entry.permission.action ?? DEFAULT_ACTION,
        dangerous: entry.permission.danger !== "safe",
      };
    }
    if (event.toolName.startsWith("mcp_")) {
      return { action: "mcp.call", dangerous: true };
    }
    if (event.toolName.startsWith("mcp_")) {
      return { action: "mcp.call", dangerous: true };
    }
    // Unregistered tool: preserve the legacy name heuristic (permissive except delete/remove).
    if (/delete|remove/i.test(event.toolName)) {
      return { action: "file.delete", dangerous: true };
    }
    return { action: DEFAULT_ACTION, dangerous: false };
  }

  getEntry(name: string): ToolCatalogEntry | undefined {
    return this.entries.get(name);
  }

  capabilitiesFor(name: string): ToolCapability[] {
    const entry = this.entries.get(name);
    if (!entry) {
      return [];
    }
    if (entry.capabilities) {
      return entry.capabilities;
    }
    if (entry.readOnly === false || entry.permission.danger !== "safe") {
      return ["write"];
    }
    return ["read"];
  }

  isReadOnlySafe(name: string): boolean {
    return !this.capabilitiesFor(name).some((capability) => WRITE_CAPABILITIES.has(capability));
  }

  matchesSelector(name: string, selector: string): boolean {
    const normalized = selector.trim();
    if (!normalized) {
      return false;
    }
    if (this.entries.has(normalized)) {
      return name === normalized;
    }
    return this.capabilitiesFor(name).includes(normalized as ToolCapability);
  }
}

/** Process-wide registry seeded with the built-in tools. */
export const toolRegistry = new ToolRegistry();
