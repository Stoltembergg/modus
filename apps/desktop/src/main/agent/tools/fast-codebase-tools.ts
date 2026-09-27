import { isAbsolute, relative, resolve } from "node:path";
import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { FAST_CODEBASE_TOOL_UI } from "../../../shared/tools";
import {
  type FastCodebaseResult,
  runFastCodebase,
} from "../../fast-codebase/fast-codebase-service";
import { recordAgentEvent } from "../agent-event-store";
import { getActiveAgentRun } from "../agent-run-store";
import { toolRegistry } from "./registry";
import { resolveAgentToolContext } from "./tool-context";

function toResult(result: FastCodebaseResult): AgentToolResult<FastCodebaseResult["details"]> {
  return { content: [{ type: "text", text: result.text }], details: result.details };
}

function safeDiscoveryHits(
  hits: FastCodebaseResult["hits"],
  workspace: string,
): FastCodebaseResult["hits"] {
  if (!Array.isArray(hits)) return [];
  const root = resolve(workspace);
  const seen = new Set<string>();
  const safe: FastCodebaseResult["hits"] = [];
  for (const candidate of hits) {
    if (!candidate || typeof candidate.path !== "string") continue;
    const path = candidate.path.replace(/\\/g, "/");
    if (
      !path ||
      path.includes("\0") ||
      path.startsWith("/") ||
      /^[a-zA-Z]:/.test(path) ||
      isAbsolute(path) ||
      path.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      continue;
    }
    const absolute = resolve(root, path);
    const relativePath = relative(root, absolute).replace(/\\/g, "/");
    if (
      !relativePath ||
      relativePath.length > 512 ||
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      isAbsolute(relativePath)
    ) {
      continue;
    }
    const symbol =
      typeof candidate.symbol === "string" && candidate.symbol.trim()
        ? candidate.symbol.trim().slice(0, 256)
        : undefined;
    const kind =
      typeof candidate.kind === "string" && candidate.kind.trim()
        ? candidate.kind.trim().slice(0, 64)
        : undefined;
    const line =
      typeof candidate.line === "number" &&
      Number.isSafeInteger(candidate.line) &&
      candidate.line > 0
        ? candidate.line
        : undefined;
    const hit = {
      path: relativePath,
      ...(symbol ? { symbol } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(kind ? { kind } : {}),
    };
    const key = JSON.stringify(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push(hit);
    if (safe.length >= 50) break;
  }
  return safe;
}

const fastCodebaseParams = Type.Object({
  query: Type.String({
    description:
      "Natural-language task, symbol, file, or subsystem to locate in the current workspace.",
  }),
  include_code: Type.Optional(
    Type.Boolean({
      description:
        "Include source snippets only for narrow implementation lookups. Omit for first discovery queries.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Result detail budget from 1 to 12. Default 8.",
    }),
  ),
  workspace_path: Type.Optional(
    Type.String({
      description: "Optional subdirectory inside the current workspace to index and query.",
    }),
  ),
});

const fastCodebaseTool: ToolDefinition<typeof fastCodebaseParams> = defineTool({
  name: "fast_codebase",
  label: "Fast Codebase",
  description:
    "Explore the current workspace's local codebase index before broad file reading. " +
    "Use it to find relevant files, symbols, architecture entry points, and a few code snippets " +
    "with far fewer tokens than grep/read exploration. It is read-only and local; read the live " +
    "file before editing because the index is a navigation snapshot.",
  promptSnippet:
    "fast_codebase(query, include_code=false, limit=8) — locate exact hits, files, and symbols before reading source.",
  promptGuidelines: [
    "Prefer fast_codebase for codebase discovery, architecture, where-is, dependencies, relationships, and locating likely files; it is usually cheaper than broad read/grep.",
    "Treat Fast Codebase as a code map, not the source of truth: read the specific current file before editing.",
    "For the first broad query in a task, omit include_code and ask for coordinates first.",
    "Set include_code true only for a narrow follow-up on an exact function, class, or file implementation.",
    "Keep limit between 8 and 12; use a narrower query instead of a larger limit.",
    "When the first map is close but lacks exact evidence, call fast_codebase again with a narrower query using returned names, files, APIs, or relationships.",
    "Use read after Fast Codebase identifies specific files or line ranges and you need implementation details.",
    "Use grep mainly for exact literal checks, absence proof, or when the code map clearly misses the area; scope it to mapped files or directories when possible.",
    "Use workspace_path only when you need to focus on a subdirectory inside the current workspace.",
  ],
  parameters: fastCodebaseParams,
  execute: async (
    _toolCallId,
    params: Static<typeof fastCodebaseParams>,
    signal,
    onUpdate,
    ctx,
  ) => {
    const context = resolveAgentToolContext(ctx.cwd);
    const update = onUpdate as
      | AgentToolUpdateCallback<Partial<FastCodebaseResult["details"]>>
      | undefined;
    const progressDetails = {
      indexed: false,
      project: "",
      query: params.query,
      workspace: context.cwd || ctx.cwd,
    };
    try {
      const result = await runFastCodebase({
        cwd: context.cwd || ctx.cwd,
        includeCode: params.include_code,
        limit: params.limit,
        query: params.query,
        signal,
        workspacePath: params.workspace_path,
        onProgress: (progress) => {
          update?.({
            content: [{ type: "text", text: `${progress.phase}: ${progress.message}` }],
            details: progressDetails,
          });
        },
      });
      const hits = safeDiscoveryHits(result.hits, context.cwd || ctx.cwd);
      const activeRun = getActiveAgentRun(context.sessionId);
      if (activeRun && hits.length > 0) {
        recordAgentEvent({
          type: "codegraph.discoveries",
          sessionId: context.sessionId,
          runId: activeRun.id,
          hits,
        });
      }
      const final = toResult(result);
      update?.(final);
      return final;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\n\nFast Codebase is unavailable for this turn. Fall back to read/grep/find and keep going.`,
      );
    }
  },
});

let registered = false;

/** Register the Fast Codebase tool into the shared registry (idempotent). */
export function registerFastCodebaseTools(): void {
  if (registered) {
    return;
  }
  registered = true;
  toolRegistry.registerTool({
    entry: {
      name: "fast_codebase",
      profiles: ["chat", "plan"],
      permission: { danger: "safe" },
      capabilities: ["read"],
      ui: FAST_CODEBASE_TOOL_UI,
    },
    definition: fastCodebaseTool,
  });
}
