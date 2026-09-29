import { createHash } from "node:crypto";
import type { CodeGraphDiscoveryHit, ProjectImpactEstimate } from "../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";
import { getDatabase } from "../../db/database";
import { estimateProjectImpact, type ProjectModelImpactInput } from "./project-model";

export const MAX_PROJECT_MODEL_EDGES = 2000;
export const MAX_EDGE_PATH_LENGTH = 512;

const SAFE_WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ProjectModelEdge = {
  workspaceId: string;
  revision: string;
  fromPath: string;
  toPath: string;
  kind: "discovery" | "changed" | "depends";
  source: "codegraph" | "git" | "checkpoint";
  updatedAt: string;
};

function normalizePath(path: string): string | undefined {
  const value = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || value.length > MAX_EDGE_PATH_LENGTH || value.includes("..")) return undefined;
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return undefined;
  return value;
}

function edgeKey(edge: Omit<ProjectModelEdge, "updatedAt">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: edge.workspaceId,
        revision: edge.revision,
        fromPath: edge.fromPath,
        toPath: edge.toPath,
        kind: edge.kind,
        source: edge.source,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

/** Persist typed CodeGraph discovery hits for a workspace revision (low-risk upsert). */
export function upsertProjectModelDiscoveries(input: {
  workspaceId: string;
  revision: string;
  hits: CodeGraphDiscoveryHit[];
  now?: string;
}): number {
  if (
    !SAFE_WORKSPACE.test(input.workspaceId) ||
    input.workspaceId === CHATS_WORKSPACE_ID ||
    !SAFE_WORKSPACE.test(input.revision)
  ) {
    return 0;
  }
  const now = input.now ?? new Date().toISOString();
  const db = getDatabase();
  const insert = db.prepare(
    `insert into project_model_edges
      (id, workspace_id, revision, from_path, to_path, kind, source, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set updated_at = excluded.updated_at`,
  );
  let written = 0;
  for (const hit of input.hits.slice(0, 200)) {
    const path = normalizePath(hit.path);
    if (!path) continue;
    const edge: Omit<ProjectModelEdge, "updatedAt"> = {
      workspaceId: input.workspaceId,
      revision: input.revision,
      fromPath: path,
      toPath: path,
      kind: "discovery",
      source: "codegraph",
    };
    insert.run(
      edgeKey(edge),
      edge.workspaceId,
      edge.revision,
      edge.fromPath,
      edge.toPath,
      edge.kind,
      edge.source,
      now,
    );
    written += 1;
  }
  return written;
}

export function upsertProjectModelChangedPaths(input: {
  workspaceId: string;
  revision: string;
  paths: string[];
  now?: string;
}): number {
  if (
    !SAFE_WORKSPACE.test(input.workspaceId) ||
    input.workspaceId === CHATS_WORKSPACE_ID ||
    !SAFE_WORKSPACE.test(input.revision)
  ) {
    return 0;
  }
  const now = input.now ?? new Date().toISOString();
  const db = getDatabase();
  const insert = db.prepare(
    `insert into project_model_edges
      (id, workspace_id, revision, from_path, to_path, kind, source, updated_at)
     values (?, ?, ?, ?, ?, 'changed', 'git', ?)
     on conflict(id) do update set updated_at = excluded.updated_at`,
  );
  let written = 0;
  for (const raw of input.paths.slice(0, 500)) {
    const path = normalizePath(raw);
    if (!path) continue;
    const id = edgeKey({
      workspaceId: input.workspaceId,
      revision: input.revision,
      fromPath: path,
      toPath: path,
      kind: "changed",
      source: "git",
    });
    insert.run(id, input.workspaceId, input.revision, path, path, now);
    written += 1;
  }
  return written;
}

export function listProjectModelEdges(
  workspaceId: string,
  revision?: string,
  limit = 500,
): ProjectModelEdge[] {
  if (!SAFE_WORKSPACE.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return [];
  const db = getDatabase();
  const capped = Math.min(Math.max(limit, 1), MAX_PROJECT_MODEL_EDGES);
  const rows = revision
    ? (db
        .prepare(
          `select workspace_id, revision, from_path, to_path, kind, source, updated_at
           from project_model_edges
           where workspace_id = ? and revision = ?
           order by updated_at desc limit ?`,
        )
        .all(workspaceId, revision, capped) as Array<Record<string, string>>)
    : (db
        .prepare(
          `select workspace_id, revision, from_path, to_path, kind, source, updated_at
           from project_model_edges
           where workspace_id = ?
           order by updated_at desc limit ?`,
        )
        .all(workspaceId, capped) as Array<Record<string, string>>);
  return rows.map((row) => ({
    workspaceId: row.workspace_id!,
    revision: row.revision!,
    fromPath: row.from_path!,
    toPath: row.to_path!,
    kind: row.kind as ProjectModelEdge["kind"],
    source: row.source as ProjectModelEdge["source"],
    updatedAt: row.updated_at!,
  }));
}

export function estimateProjectImpactWithStore(
  workspaceId: string,
  input: ProjectModelImpactInput,
): ProjectImpactEstimate {
  const edges = listProjectModelEdges(workspaceId, input.revision, 500);
  const storedHits: CodeGraphDiscoveryHit[] = edges
    .filter((edge) => edge.source === "codegraph")
    .map((edge) => ({ path: edge.fromPath }));
  const storedChanged = edges
    .filter((edge) => edge.kind === "changed")
    .map((edge) => edge.fromPath);
  const estimate = estimateProjectImpact({
    ...input,
    changedPaths: [...new Set([...input.changedPaths, ...storedChanged])],
    codegraphHits: [...(input.codegraphHits ?? []), ...storedHits],
  });
  if (edges.length > 0) {
    estimate.reasonCodes = [...new Set([...estimate.reasonCodes, "stored_edges_used"])];
    if (estimate.unknownReasons.includes("no_codegraph_edges") && storedHits.length > 0) {
      estimate.unknownReasons = estimate.unknownReasons.filter(
        (reason) => reason !== "no_codegraph_edges",
      );
    }
  }
  persistImpactSnapshot(workspaceId, estimate);
  return estimate;
}

function persistImpactSnapshot(workspaceId: string, estimate: ProjectImpactEstimate): void {
  if (!SAFE_WORKSPACE.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return;
  const revision = estimate.revision ?? "unknown";
  if (!SAFE_WORKSPACE.test(revision) && revision !== "unknown") return;
  const db = getDatabase();
  const id = createHash("sha256").update(`${workspaceId}:${revision}`).digest("hex").slice(0, 32);
  db.prepare(
    `insert into project_model_snapshots (id, workspace_id, revision, estimate_json, updated_at)
     values (?, ?, ?, ?, ?)
     on conflict(id) do update set estimate_json = excluded.estimate_json, updated_at = excluded.updated_at`,
  ).run(id, workspaceId, revision, JSON.stringify(estimate), new Date().toISOString());
}

export function getLatestImpactSnapshot(
  workspaceId: string,
  revision?: string,
): ProjectImpactEstimate | undefined {
  if (!SAFE_WORKSPACE.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return undefined;
  const db = getDatabase();
  const row = (
    revision
      ? db
          .prepare(
            `select estimate_json from project_model_snapshots
             where workspace_id = ? and revision = ? limit 1`,
          )
          .get(workspaceId, revision)
      : db
          .prepare(
            `select estimate_json from project_model_snapshots
             where workspace_id = ? order by updated_at desc limit 1`,
          )
          .get(workspaceId)
  ) as { estimate_json?: string } | undefined;
  if (!row?.estimate_json) return undefined;
  try {
    return JSON.parse(row.estimate_json) as ProjectImpactEstimate;
  } catch {
    return undefined;
  }
}
