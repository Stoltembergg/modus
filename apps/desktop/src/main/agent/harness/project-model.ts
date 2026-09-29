import type {
  CodeGraphDiscoveryHit,
  ProjectImpactConfidence,
  ProjectImpactEstimate,
} from "../../../shared/contracts";

export type ProjectModelImpactInput = {
  revision?: string;
  changedPaths: string[];
  codegraphHits?: CodeGraphDiscoveryHit[];
  planCriterionCount?: number;
  verifiedMemoryCount?: number;
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function subsystem(path: string): string {
  const segments = normalizePath(path).split("/").filter(Boolean);
  const sourceRootIndex = segments.indexOf("src");
  if (sourceRootIndex >= 0) return segments[sourceRootIndex + 1] ?? "";
  return segments.length > 1 ? (segments[0] ?? "") : "";
}

function confidenceFromSignals(
  pathCount: number,
  hitCount: number,
  hasRevision: boolean,
): ProjectImpactConfidence {
  if (pathCount === 0 && hitCount === 0) return "unknown";
  if (!hasRevision && pathCount === 0) return "unknown";
  if (pathCount >= 4 || hitCount >= 6) return "high";
  if (pathCount >= 2 || hitCount >= 2) return "medium";
  return "low";
}

/**
 * Ephemeral, revision-scoped impact estimate. Does not create a second graph DB.
 * Missing typed edges yield `unknown` rather than inferred certainty from prose.
 */
export function estimateProjectImpact(input: ProjectModelImpactInput): ProjectImpactEstimate {
  const paths = [
    ...new Set(
      input.changedPaths
        .map(normalizePath)
        .filter((path) => path.length > 0 && path.length <= 512 && !path.includes("..")),
    ),
  ];
  const hits = (input.codegraphHits ?? []).filter(
    (hit) => typeof hit.path === "string" && hit.path.length > 0 && hit.path.length <= 512,
  );
  const hitPaths = [...new Set(hits.map((hit) => normalizePath(hit.path)))];
  const unionPaths = [...new Set([...paths, ...hitPaths])];
  const subsystems = new Set(unionPaths.map(subsystem).filter((value) => value.length > 0));
  const unknownReasons: string[] = [];
  const reasonCodes: string[] = [];

  if (!input.revision) {
    unknownReasons.push("missing_revision");
    reasonCodes.push("revision_absent");
  }
  if (unionPaths.length === 0) {
    unknownReasons.push("no_typed_paths");
    reasonCodes.push("empty_scope");
  }
  if (hits.length === 0 && paths.length > 0) {
    unknownReasons.push("no_codegraph_edges");
    reasonCodes.push("codegraph_absent");
  }
  if ((input.planCriterionCount ?? 0) > 0) reasonCodes.push("plan_criteria_present");
  if ((input.verifiedMemoryCount ?? 0) > 0) reasonCodes.push("verified_memory_present");

  let blastRadius: ProjectImpactEstimate["blastRadius"] = "unknown";
  if (unionPaths.length === 0) {
    blastRadius = unknownReasons.length ? "unknown" : "none";
  } else if (subsystems.size >= 3 || unionPaths.length >= 8) {
    blastRadius = "cross_module";
    reasonCodes.push("cross_module_scope");
  } else if (subsystems.size >= 2 || unionPaths.length >= 4) {
    blastRadius = "module";
    reasonCodes.push("module_scope");
  } else {
    blastRadius = "local";
    reasonCodes.push("local_scope");
  }

  const confidence = confidenceFromSignals(paths.length, hits.length, Boolean(input.revision));
  if (confidence === "unknown" && !unknownReasons.includes("no_typed_paths")) {
    unknownReasons.push("insufficient_typed_signals");
  }

  return {
    ...(input.revision ? { revision: input.revision } : {}),
    blastRadius,
    impactedPathCount: unionPaths.length,
    confidence,
    unknownReasons,
    reasonCodes: [...new Set(reasonCodes)],
  };
}
