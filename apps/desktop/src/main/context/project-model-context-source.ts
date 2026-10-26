import { CHATS_WORKSPACE_ID, type ProjectMemoryEvidence } from "../../shared/contracts";
import { listProjectModelEdges } from "../agent/harness/project-model-store";
import type {
  ContextCandidate,
  ContextCandidateSource,
  ContextPlannerInput,
} from "./context-planner";

export const PROJECT_MODEL_CONTEXT_SOURCE_ID = "project-model-codegraph";
export const PROJECT_MODEL_CONTEXT_EDGE_LIMIT = 80;

const COMMIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const QUERY_TERM_LIMIT = 16;

function normalizeProjectPath(raw: string): string | undefined {
  const path = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    !path ||
    path.length > 512 ||
    path.includes("..") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return undefined;
  }
  const segments = path.split("/").filter((segment) => segment && segment !== ".");
  return segments.length > 0 ? segments.join("/") : undefined;
}

function terms(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, QUERY_TERM_LIMIT) ?? [],
  );
}

/** Reuses only code-map discoveries explicitly tied to the current Git commit. */
export function createProjectModelContextSource(): ContextCandidateSource {
  return {
    sourceId: PROJECT_MODEL_CONTEXT_SOURCE_ID,
    async retrieve(input: ContextPlannerInput): Promise<ContextCandidate[]> {
      const { workspaceId } = input;
      const revision = input.git.head;
      if (
        !workspaceId ||
        input.inbox ||
        workspaceId === CHATS_WORKSPACE_ID ||
        !revision ||
        !COMMIT_REVISION.test(revision)
      ) {
        return [];
      }

      const expectedPaths = new Set(
        [...input.contextPaths, ...input.git.changedPaths]
          .map(normalizeProjectPath)
          .filter((path): path is string => path !== undefined),
      );
      const queryTerms = terms(input.query);
      const byPath = new Map<string, { score: number; evidence: ProjectMemoryEvidence }>();
      for (const edge of listProjectModelEdges(
        workspaceId,
        revision,
        PROJECT_MODEL_CONTEXT_EDGE_LIMIT,
      )) {
        if (
          edge.revision !== revision ||
          edge.source !== "codegraph" ||
          edge.kind !== "discovery"
        ) {
          continue;
        }
        const path = normalizeProjectPath(edge.fromPath);
        if (!path) continue;
        const pathTerms = terms(path);
        const overlap = [...queryTerms].filter((term) => pathTerms.has(term)).length;
        const score =
          (expectedPaths.has(path) ? 100 : 0) +
          overlap * 8 +
          (edge.fromPath === edge.toPath ? 1 : 0);
        const previous = byPath.get(path);
        if (!previous || score > previous.score) {
          byPath.set(path, {
            score,
            evidence: { kind: "file", path, commitSha: revision },
          });
        }
      }

      return [...byPath.entries()]
        .sort(
          ([leftPath, left], [rightPath, right]) =>
            right.score - left.score || leftPath.localeCompare(rightPath),
        )
        .slice(0, PROJECT_MODEL_CONTEXT_EDGE_LIMIT)
        .map(([path, value]) => ({
          id: `project-model:${revision}:${path}`,
          sourceId: PROJECT_MODEL_CONTEXT_SOURCE_ID,
          scope: { kind: "project" as const, workspaceId },
          text: `Cached code-map discovery: ${path}`,
          score: value.score,
          trust: "code-map" as const,
          evidence: [value.evidence],
        }));
    },
  };
}
