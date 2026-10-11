import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  getDatabase: vi.fn(),
  getModelRegistry: vi.fn(),
  loaderOptions: undefined as Record<string, unknown> | undefined,
  readDiff: vi.fn(),
  resolveActiveTools: vi.fn(),
  getCustomToolDefinitions: vi.fn(),
  reload: vi.fn(),
  userDataPath: "",
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mocks.createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: Record<string, unknown>) {
      mocks.loaderOptions = options;
    }

    async reload() {
      mocks.reload();
    }
  },
  SessionManager: { inMemory: () => ({}) },
  SettingsManager: { inMemory: () => ({}) },
}));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.userDataPath },
}));

vi.mock("../db/database", () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock("../git/git-service", () => ({
  readDiff: mocks.readDiff,
}));

vi.mock("./model-service", () => ({
  findModel: (id: string) => ({ id }),
  getDefaultModel: () => undefined,
  getModelRegistry: mocks.getModelRegistry,
  isUsableModelId: () => true,
}));

vi.mock("./tools/registry", () => ({
  toolRegistry: {
    resolveActiveTools: mocks.resolveActiveTools,
    getCustomToolDefinitions: mocks.getCustomToolDefinitions,
  },
}));

import { startAgentReview } from "./review-service";

describe("review-service Pi SDK runtime wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loaderOptions = undefined;
    mocks.userDataPath = "";
    mocks.readDiff.mockImplementation(async (_cwd: string, _ref: unknown, mode: string) => ({
      diff: `${mode} change`,
    }));
    mocks.getDatabase.mockReturnValue({
      prepare: () => ({ run: vi.fn() }),
    });
    mocks.getModelRegistry.mockReturnValue({ authStorage: {} });
    mocks.resolveActiveTools.mockReturnValue(["review-tool"]);
    mocks.getCustomToolDefinitions.mockReturnValue(["review-custom-tool"]);
    mocks.createAgentSession.mockResolvedValue({
      session: {
        subscribe: () => () => {},
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    });
  });

  it("disables Pi extension discovery on the productive review path", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "modus-review-runtime-"));
    mocks.userDataPath = userDataPath;

    try {
      await startAgentReview({ cwd: userDataPath, modelId: "chosen-model" });

      expect(mocks.reload).toHaveBeenCalledOnce();
      expect(mocks.loaderOptions).toMatchObject({
        cwd: userDataPath,
        agentDir: join(userDataPath, "pi-agent"),
        noExtensions: true,
      });
      expect(mocks.createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { id: "chosen-model" },
          tools: ["review-tool"],
          customTools: ["review-custom-tool"],
        }),
      );
      expect(mocks.resolveActiveTools).toHaveBeenCalledExactlyOnceWith("review");
      expect(mocks.getCustomToolDefinitions).toHaveBeenCalledExactlyOnceWith("review");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
