import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectModelEdge } from "../agent/harness/project-model-store";
import { listProjectModelEdges } from "../agent/harness/project-model-store";
import type { ContextPlannerInput } from "./context-planner";
import { createProjectModelContextSource } from "./project-model-context-source";

vi.mock("../agent/harness/project-model-store", () => ({
  listProjectModelEdges: vi.fn(),
}));

const HEAD = "a".repeat(40);
const WORKSPACE = "workspace-context-source";

function edge(fromPath: string, overrides: Partial<ProjectModelEdge> = {}): ProjectModelEdge {
  return {
    workspaceId: WORKSPACE,
    revision: HEAD,
    fromPath,
    toPath: fromPath,
    kind: "discovery",
    source: "codegraph",
    updatedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<ContextPlannerInput> = {}): ContextPlannerInput {
  return {
    workspaceId: WORKSPACE,
    inbox: false,
    query: "cache adapter",
    contextPaths: [],
    contextSymbols: [],
    git: { head: HEAD, changedPaths: [] },
    sessionId: "session-a",
    ...overrides,
  };
}

describe("Project Model context source", () => {
  beforeEach(() => vi.mocked(listProjectModelEdges).mockReset());

  it("reads only the current revision and emits bounded untrusted code-map hints", async () => {
    vi.mocked(listProjectModelEdges).mockReturnValue([
      edge("src/cache-adapter.ts"),
      edge("src/cache.ts"),
      edge("../outside.ts"),
      edge("src/changed.ts", { kind: "changed", source: "git" }),
    ]);
    const source = createProjectModelContextSource();

    const candidates = await source.retrieve(
      input({ contextPaths: ["src/cache-adapter.ts"], query: "cache adapter" }),
    );

    expect(listProjectModelEdges).toHaveBeenCalledWith(WORKSPACE, HEAD, 80);
    expect(candidates.map(({ id }) => id)).toEqual([
      `project-model:${HEAD}:src/cache-adapter.ts`,
      `project-model:${HEAD}:src/cache.ts`,
    ]);
    expect(candidates[0]).toMatchObject({
      sourceId: "project-model-codegraph",
      scope: { kind: "project", workspaceId: WORKSPACE },
      trust: "code-map",
      evidence: [{ kind: "file", path: "src/cache-adapter.ts", commitSha: HEAD }],
    });
  });

  it("does not query revisionless, inbox, or workspace-less context", async () => {
    const source = createProjectModelContextSource();
    const workspaceLessInput = input();
    delete workspaceLessInput.workspaceId;

    await expect(source.retrieve(input({ git: { changedPaths: [] } }))).resolves.toEqual([]);
    await expect(source.retrieve(input({ inbox: true }))).resolves.toEqual([]);
    await expect(source.retrieve(workspaceLessInput)).resolves.toEqual([]);

    expect(listProjectModelEdges).not.toHaveBeenCalled();
  });

  it("uses exact paths and query relevance to rank within the bounded edge set", async () => {
    vi.mocked(listProjectModelEdges).mockReturnValue([
      edge("src/unrelated.ts"),
      edge("src/adapter/cache-index.ts"),
    ]);
    const candidates = await createProjectModelContextSource().retrieve(
      input({ query: "cache index", contextPaths: ["src/adapter/cache-index.ts"] }),
    );

    expect(candidates[0]?.id).toBe(`project-model:${HEAD}:src/adapter/cache-index.ts`);
    expect(candidates[0]?.score).toBeGreaterThan(candidates[1]?.score ?? 0);
  });

  it("caps the returned discoveries even if the store returns more than requested", async () => {
    vi.mocked(listProjectModelEdges).mockReturnValue(
      Array.from({ length: 100 }, (_, index) => edge(`src/cache-${index}.ts`)),
    );

    const candidates = await createProjectModelContextSource().retrieve(input());

    expect(candidates).toHaveLength(80);
  });
});
