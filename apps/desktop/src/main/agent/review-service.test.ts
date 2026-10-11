import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reviewMocks = vi.hoisted(() => {
  const selectedModel = { id: "review-model", provider: "mock-selected" };
  const defaultModel = { id: "default-model", provider: "mock-default" };
  return {
    createAgentSession: vi.fn(),
    loaderOptions: [] as unknown[],
    loaderReload: vi.fn(),
    readDiff: vi.fn(),
    getPath: vi.fn(() => "/tmp"),
    selectedModel,
    defaultModel,
    database: { prepare: vi.fn(() => ({ run: vi.fn() })) },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: reviewMocks.createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: unknown) {
      reviewMocks.loaderOptions.push(options);
    }
    reload(): Promise<void> {
      return reviewMocks.loaderReload();
    }
  },
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
}));

vi.mock("electron", () => ({ app: { getPath: reviewMocks.getPath } }));
vi.mock("../db/database", () => ({ getDatabase: () => reviewMocks.database }));
vi.mock("../git/git-service", () => ({ readDiff: reviewMocks.readDiff }));
vi.mock("./model-service", () => ({
  findModel: vi.fn(() => reviewMocks.selectedModel),
  getDefaultModel: vi.fn(() => reviewMocks.defaultModel),
  getModelRegistry: vi.fn(() => ({ authStorage: {} })),
  isUsableModelId: vi.fn(() => true),
}));
vi.mock("./tools/registry", () => ({
  toolRegistry: {
    resolveActiveTools: vi.fn(() => []),
    getCustomToolDefinitions: vi.fn(() => []),
  },
}));

const { startAgentReview, inspectDiff, parseReviewOutput } = await import("./review-service");

describe("review-service", () => {
  let userData: string;

  beforeEach(async () => {
    userData = await mkdtemp(join(tmpdir(), "modus-review-service-"));
    reviewMocks.getPath.mockReturnValue(userData);
    reviewMocks.loaderOptions.length = 0;
    reviewMocks.loaderReload.mockReset().mockResolvedValue(undefined);
    reviewMocks.readDiff.mockReset().mockResolvedValue({ diff: "+synthetic review change" });
    reviewMocks.database.prepare.mockClear();
    const session = {
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listener({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: '{"summary":"Synthetic review complete","issues":[]}',
          },
        });
        return vi.fn();
      }),
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };
    reviewMocks.createAgentSession.mockReset().mockResolvedValue({ session });
  });

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  it("keeps the productive review Pi loader from discovering extensions", async () => {
    const result = await startAgentReview({ cwd: userData, modelId: "mock/review-model" });

    expect(result).toMatchObject({ status: "completed", summary: "Synthetic review complete" });
    expect(reviewMocks.loaderOptions).toHaveLength(1);
    expect(reviewMocks.loaderOptions[0]).toMatchObject({ cwd: userData, noExtensions: true });
    expect(reviewMocks.loaderOptions[0]).not.toHaveProperty("additionalExtensionPaths");
    expect(reviewMocks.loaderOptions[0]).not.toHaveProperty("extensionFactories");
    expect(reviewMocks.loaderReload).toHaveBeenCalledOnce();
    expect(reviewMocks.createAgentSession).toHaveBeenCalledOnce();
    expect(reviewMocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: reviewMocks.selectedModel }),
    );
  });

  it("parses strict JSON review output", () => {
    const result = parseReviewOutput(
      '{"summary":"Looks good","issues":[{"severity":"high","title":"Bug","file":"src/a.ts","line":12,"detail":"Breaks flow"}]}',
      "",
    );

    expect(result.summary).toBe("Looks good");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ severity: "high", title: "Bug" });
    expect(result.issues[0]?.id).toBeTruthy();
  });

  it("parses fenced JSON review output", () => {
    const result = parseReviewOutput('```json\n{"summary":"Done","issues":[]}\n```', "");

    expect(result).toMatchObject({ summary: "Done", issues: [] });
  });

  it("falls back to heuristic issues", () => {
    const diff = `diff --git a/.env b/.env
+++ b/.env
@@ -0,0 +1 @@
+api_key = "secret"`;
    const result = parseReviewOutput("not json", diff);

    expect(result.summary).toBe("not json");
    expect(result.issues[0]?.title).toBe("Possible secret in added code");
  });

  it("detects heuristic TODO and secrets", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
+++ b/src/a.ts
@@ -1,0 +1,2 @@
+const token = "abc";
+// TODO finish`;

    expect(inspectDiff(diff).map((issue) => issue.title)).toEqual([
      "Possible secret in added code",
      "Unresolved TODO in diff",
    ]);
  });
});
