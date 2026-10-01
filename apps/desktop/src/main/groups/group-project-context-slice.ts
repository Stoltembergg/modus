import type { ProjectModelEdge } from "../agent/harness/project-model-store";
import { listProjectModelEdges } from "../agent/harness/project-model-store";
import { getProjectMemoriesForPlanning } from "../memory/project-memory-service";

/** Role buckets used to slice the shared Project Model for a wake. */
export type GroupProjectRoleSlice = "planner" | "builder" | "reviewer" | "explorer" | "general";

export function classifyGroupProjectRole(role: string | undefined): GroupProjectRoleSlice {
  const value = (role ?? "").toLowerCase();
  if (/\b(plan|planner|architect|lead|pm)\b/.test(value)) return "planner";
  if (/\b(build|builder|implement|engineer|dev|coder)\b/.test(value)) return "builder";
  if (/\b(review|reviewer|qa|verify|critic)\b/.test(value)) return "reviewer";
  if (/\b(explor\w*|research\w*|discover\w*|scout)\b/.test(value)) return "explorer";
  return "general";
}

const ROLE_KIND_PREFERENCE: Record<GroupProjectRoleSlice, ProjectModelEdge["kind"][]> = {
  planner: ["discovery", "depends", "changed"],
  builder: ["changed", "depends", "discovery"],
  reviewer: ["changed", "discovery", "depends"],
  explorer: ["discovery", "depends", "changed"],
  general: ["discovery", "changed", "depends"],
};

const MAX_SLICE_LINES = 24;

/**
 * Select edges for a role + optional prompt keywords. Prefer consulting this
 * shared map before broad repo search.
 */
export function selectProjectModelSlice(input: {
  edges: readonly ProjectModelEdge[];
  role: GroupProjectRoleSlice;
  prompt?: string;
  limit?: number;
}): ProjectModelEdge[] {
  const limit = Math.min(Math.max(input.limit ?? MAX_SLICE_LINES, 1), 48);
  const prompt = (input.prompt ?? "").toLowerCase();
  const tokens = prompt
    .split(/[^a-z0-9_./-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 24);
  const preferred = ROLE_KIND_PREFERENCE[input.role];
  const scored = input.edges.map((edge, index) => {
    let score = 0;
    const kindRank = preferred.indexOf(edge.kind);
    score += kindRank >= 0 ? (preferred.length - kindRank) * 10 : 0;
    if (input.role === "builder" && edge.kind === "changed") score += 8;
    if (input.role === "planner" && edge.kind === "discovery") score += 6;
    if (input.role === "reviewer" && edge.kind === "changed") score += 6;
    if (tokens.length > 0) {
      const hay = `${edge.fromPath} ${edge.toPath}`.toLowerCase();
      for (const token of tokens) {
        if (hay.includes(token)) score += 12;
      }
    }
    return { edge, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((row) => row.edge);
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Bounded wake section: shared Project Model slice for this member's role.
 * Instructs the agent to consult the map before broad search.
 */
export function composeGroupProjectContextSection(input: {
  role: string | undefined;
  edges: readonly ProjectModelEdge[];
  memoryDigest?: readonly string[];
  prompt?: string;
}): string {
  const sliceRole = classifyGroupProjectRole(input.role);
  const edges = selectProjectModelSlice({
    edges: input.edges,
    role: sliceRole,
    ...(input.prompt ? { prompt: input.prompt } : {}),
  });
  const lines = [
    `<project_context role="${escapeText(sliceRole)}">`,
    "Shared project map (Project Model / CodeGraph). Consult this before broad search; open extra files only on real uncertainty or stale context.",
  ];
  if (edges.length === 0) {
    lines.push("- (map warming — prefer fast_codebase over recursive reads)");
  } else {
    for (const edge of edges) {
      if (edge.kind === "depends") {
        lines.push(`- depends ${escapeText(edge.fromPath)} → ${escapeText(edge.toPath)}`);
      } else {
        lines.push(`- ${edge.kind} ${escapeText(edge.fromPath)}`);
      }
    }
  }
  for (const claim of (input.memoryDigest ?? []).slice(0, 6)) {
    const trimmed = claim.trim();
    if (trimmed) lines.push(`- memory: ${escapeText(trimmed.slice(0, 180))}`);
  }
  lines.push("</project_context>");
  return lines.join("\n");
}

/** Load role-scoped slice from existing Project Model + planning memories. */
export function loadGroupProjectContextSection(input: {
  workspaceId: string;
  role?: string;
  prompt?: string;
}): string | undefined {
  if (!input.workspaceId) return undefined;
  const edges = listProjectModelEdges(input.workspaceId, undefined, 400);
  let memoryDigest: string[] = [];
  try {
    const memories = getProjectMemoriesForPlanning({
      workspaceId: input.workspaceId,
      inbox: false,
      contextPaths: edges.slice(0, 16).map((edge) => edge.fromPath),
      contextSymbols: [],
    });
    memoryDigest = memories
      .filter((memory) => memory.category === "architecture" || memory.category === "convention")
      .slice(0, 6)
      .map((memory) => memory.claim);
  } catch {
    memoryDigest = [];
  }
  if (edges.length === 0 && memoryDigest.length === 0) {
    // Still emit the consult-map instruction so wakes prefer shared map / fast_codebase.
    return composeGroupProjectContextSection({
      role: input.role,
      edges: [],
      ...(input.prompt ? { prompt: input.prompt } : {}),
    });
  }
  return composeGroupProjectContextSection({
    role: input.role,
    edges,
    memoryDigest,
    ...(input.prompt ? { prompt: input.prompt } : {}),
  });
}
