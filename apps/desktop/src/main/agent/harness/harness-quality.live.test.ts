import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { BrowserWindow } from "electron";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QUALITY_FIXTURES, verifyFixture } from "../../../../scripts/harness-quality/fixtures";
import { QualityRunReporter } from "../../../../scripts/harness-quality/report";
import {
  fixtureFilePath,
  fixtureToolDecision,
  QUALITY_TOOL_NAMES,
} from "../../../../scripts/harness-quality/scope";
import type { ThinkingLevel } from "../../../shared/contracts";

const boundary = vi.hoisted(() => ({
  userData: "",
  home: "",
  workspace: "",
  model: "",
  files: [] as string[],
  writable: [] as string[],
  delegationAllowed: false,
  tasksStarted: 0,
  sessionsCreated: 0,
  deniedTools: [] as string[],
}));

// Desktop and discovery boundaries only. No installed application data is opened.
vi.mock("electron", () => ({
  app: { getPath: () => boundary.userData, getAppPath: () => boundary.userData, isPackaged: false },
  Notification: { isSupported: () => false },
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => boundary.home || "/__quality_home_not_initialized__" };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  const allowed = new Set<string>(QUALITY_TOOL_NAMES);
  return {
    ...actual,
    DefaultResourceLoader: class extends actual.DefaultResourceLoader {
      constructor(options: ConstructorParameters<typeof actual.DefaultResourceLoader>[0]) {
        if (!boundary.workspace || resolve(options.cwd) !== boundary.workspace) {
          throw new Error("Quality evaluation refused a resource loader outside its fixture.");
        }
        const guard: import("@earendil-works/pi-coding-agent").ExtensionFactory = (pi) => {
          pi.on("tool_call", (event) => {
            const decision = fixtureToolDecision({
              toolName: event.toolName,
              args: event.input,
              root: boundary.workspace,
              files: boundary.files,
              writable: boundary.writable,
              selectedModel: boundary.model,
              delegationAllowed: boundary.delegationAllowed,
              tasksStarted: boundary.tasksStarted,
            });
            if (decision) boundary.deniedTools.push(event.toolName);
            else if (event.toolName === "task") boundary.tasksStarted += 1;
            return decision;
          });
        };
        super({
          ...options,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [guard, ...(options.extensionFactories ?? [])],
        });
      }
    },
    // Assert selection and narrow the actual SDK registry; call the actual SDK.
    createAgentSession: async (options: Parameters<typeof actual.createAgentSession>[0]) => {
      if (
        !options?.model ||
        `${options.model.provider}/${options.model.id}` !== boundary.model ||
        resolve(options.cwd ?? "") !== boundary.workspace
      ) {
        throw new Error("Quality evaluation refused an unselected model or workspace.");
      }
      if (++boundary.sessionsCreated > (boundary.delegationAllowed ? 2 : 1)) {
        throw new Error("Quality evaluation fixture session limit exceeded.");
      }
      return actual.createAgentSession({
        ...options,
        tools: (options.tools ?? []).filter((name) => allowed.has(name)),
        customTools: (options.customTools ?? []).filter((tool) => allowed.has(tool.name)),
        scopedModels: (options.scopedModels ?? []).filter(
          ({ model }) => `${model.provider}/${model.id}` === boundary.model,
        ),
      });
    },
  };
});

const enabled = process.env.MODUS_HARNESS_QUALITY_LIVE === "1";
const results: Record<string, unknown>[] = [];
let scratch = "";
let manifest: Record<string, unknown> = {};
let thinkingLevel: ThinkingLevel = "off";
let setupError: string | undefined;
let reportPath = "";

describe.skipIf(!enabled)("Harness real-inference quality evaluation (explicit opt-in)", () => {
  beforeAll(async () => {
    reportPath = resolve(process.env.MODUS_HARNESS_QUALITY_REPORT ?? "harness-quality-report.json");
    boundary.model = process.env.MODUS_HARNESS_QUALITY_MODEL?.trim() ?? "";
    const thinking = process.env.MODUS_HARNESS_QUALITY_THINKING ?? "off";
    manifest = {
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      selectedModel: boundary.model,
      thinkingLevel: thinking,
      sourceRevision: process.env.MODUS_HARNESS_QUALITY_REVISION ?? null,
      fixtureHash: createHash("sha256")
        .update(JSON.stringify(QUALITY_FIXTURES.map(({ verify: _verify, ...fixture }) => fixture)))
        .digest("hex"),
      inference: "real-pi-sdk",
      boundaries: [
        "temporary Electron userData and home",
        "scoped real SDK tools",
        "fixture-only file approvals",
        "no generated code execution",
      ],
    };
    try {
      if (!/^[^/\s]+\/[^\s]+$/.test(boundary.model))
        throw new Error(
          "Set MODUS_HARNESS_QUALITY_MODEL to the user's exact provider/model choice.",
        );
      const selectedProvider = boundary.model.split("/")[0];
      if (selectedProvider === "google-vertex" || selectedProvider === "amazon-bedrock") {
        throw new Error(
          "This isolated runner does not support providers with ambient credential-file discovery (google-vertex or amazon-bedrock). It will not substitute another provider/model.",
        );
      }
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking))
        throw new Error("Invalid MODUS_HARNESS_QUALITY_THINKING.");
      thinkingLevel = thinking as ThinkingLevel;
      scratch = await realpath(await mkdtemp(join(tmpdir(), "modus-harness-quality-")));
      boundary.userData = join(scratch, "userdata");
      boundary.home = join(scratch, "home");
      await Promise.all([mkdir(boundary.userData), mkdir(boundary.home)]);
      const sdk = await import("@earendil-works/pi-coding-agent");
      // noSkills/noExtensions suppress loading, but the SDK still enumerates
      // ~/.agents in package discovery. Replace only that discovery boundary.
      const emptyResources = () => ({ extensions: [], skills: [], prompts: [], themes: [] });
      vi.spyOn(sdk.DefaultPackageManager.prototype, "resolve").mockImplementation(async () =>
        emptyResources(),
      );
      vi.spyOn(sdk.DefaultPackageManager.prototype, "resolveExtensionSources").mockImplementation(
        async (sources) => {
          if (sources.length)
            throw new Error("Quality evaluation refuses external resource sources.");
          return emptyResources();
        },
      );
      const sourceFiles = [
        new URL("../pi-sdk-runtime.ts", import.meta.url),
        new URL("../model-service.ts", import.meta.url),
        new URL("../../../../scripts/harness-quality/fixtures.ts", import.meta.url),
        new URL("../../../../scripts/harness-quality/report.ts", import.meta.url),
        new URL("../../../../scripts/harness-quality/scope.ts", import.meta.url),
        new URL("./harness-quality.live.test.ts", import.meta.url),
      ];
      manifest.sourceHashes = Object.fromEntries(
        await Promise.all(
          sourceFiles.map(async (file) => [
            file.pathname.split("/").at(-1),
            createHash("sha256")
              .update(await readFile(file))
              .digest("hex"),
          ]),
        ),
      );
      const models = await import("../model-service");
      const registry = models.getModelRegistry();
      const hasConfiguredAuth = registry.hasConfiguredAuth.bind(registry);
      // Availability normally checks every provider, including SDK ADC discovery.
      // Only the explicitly selected provider belongs in this evaluation.
      registry.hasConfiguredAuth = (model) =>
        model.provider === selectedProvider && hasConfiguredAuth(model);
      if (!models.isUsableModelId(boundary.model))
        throw new Error(
          "The selected provider/model is unavailable or lacks credentials in the isolated evaluation environment. Supply its normal provider environment credentials; no installed app credentials are loaded.",
        );
      const info = models.getModelInfo(boundary.model);
      if (!info || info.id !== boundary.model)
        throw new Error("The exact selected model could not be resolved.");
      const flags = await import("./feature-flags");
      // No plugin processes or local model downloads belong in this fixture evaluation.
      flags.setFeatureFlagOverrides({ MODUS_PLUGINS: false, MODUS_LOCAL_TOOL_FILTER: false });
      manifest.flags = flags.getFeatureFlags();
    } catch (error) {
      setupError =
        error instanceof Error ? error.message : "Quality evaluation configuration failed.";
      manifest.configurationError = setupError;
      throw error;
    }
  }, 30_000);

  afterAll(async () => {
    if (reportPath) {
      await mkdir(resolve(reportPath, ".."), { recursive: true });
      await writeFile(
        reportPath,
        `${JSON.stringify({ ...manifest, completedAt: new Date().toISOString(), status: setupError ? "configuration_error" : "evaluated", completedFixtures: results.length, passedFixtures: results.filter((result) => result.passed === true).length, results }, null, 2)}\n`,
      );
      console.info(`Harness quality report: ${reportPath}`);
    }
    if (scratch) {
      const { getDatabase } = await import("../../db/database");
      getDatabase().close();
      await rm(scratch, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  for (const fixture of QUALITY_FIXTURES) {
    it(`${fixture.language}: ${fixture.id}`, async () => {
      if (setupError) throw new Error(setupError);
      boundary.workspace = resolve(scratch, fixture.id);
      boundary.files = Object.keys(fixture.files);
      boundary.writable = fixture.writable;
      boundary.delegationAllowed = fixture.delegate === true;
      boundary.tasksStarted = 0;
      boundary.sessionsCreated = 0;
      boundary.deniedTools = [];
      await mkdir(boundary.workspace);
      await Promise.all(
        Object.entries(fixture.files).map(([path, content]) =>
          writeFile(join(boundary.workspace, path), content),
        ),
      );
      const { PiSdkRuntime } = await import("../pi-sdk-runtime");
      const { upsertWorkspace } = await import("../../workspace/workspace-store");
      const { listSubagentSessions } = await import("../agent-store");
      const { resolvePermissionRequest } = await import("../../permissions/permission-broker");
      const workspace = upsertWorkspace(boundary.workspace, false);
      const window = {
        webContents: { send() {} },
        isDestroyed: () => false,
        isFocused: () => true,
        isMinimized: () => false,
      } as unknown as BrowserWindow;
      const runtime = new PiSdkRuntime();
      const reporter = new QualityRunReporter();
      let sessionId: string | undefined;
      let timedOut = false;
      let questionPending = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const startedMs = performance.now();
      const unsubscribe = runtime.onEvent((event) => {
        reporter.observe(event, performance.now());
        if (event.type === "permission.requested") {
          const allowed =
            event.request.action === "file.write" &&
            fixtureFilePath(boundary.workspace, event.request.target, boundary.writable) !==
              undefined;
          // The broker opens its pending registry immediately after emitting the request.
          queueMicrotask(() =>
            resolvePermissionRequest(event.request.id, allowed ? "allow-once" : "deny"),
          );
        }
      });
      const unsubscribeQuestions = runtime.onQuestionPending((id) => {
        questionPending = true;
        void runtime.abort(id);
      });
      let passed = false;
      try {
        const session = await runtime.create(window, {
          workspaceId: workspace.id,
          cwd: boundary.workspace,
          title: fixture.id,
          model: boundary.model,
        });
        sessionId = session.id;
        timer = setTimeout(() => {
          timedOut = true;
          void runtime.abort(session.id);
        }, 90_000);
        const result = await runtime.prompt(window, {
          sessionId: session.id,
          message: `${fixture.prompt}\n\nThis is a trusted tiny fixture workspace. Available files: ${boundary.files.join(", ")}. File access is limited to these files. Use read/write/edit directly; shell and external tools are unavailable. Finish the requested work without asking questions.`,
          context: [],
          model: boundary.model,
          thinkingLevel,
        });
        const children = listSubagentSessions(session.id);
        const snapshot = reporter.snapshot(
          session.id,
          children.map((child) => child.id),
        );
        const files: Record<string, string> = {};
        for (const name of await readdir(boundary.workspace)) {
          const path = fixtureFilePath(boundary.workspace, name, boundary.files);
          files[name] = path ? await readFile(path, "utf8") : "<unexpected or non-regular file>";
        }
        const checks = verifyFixture(fixture, {
          files,
          childSessions: children.length,
          successfulWaits: reporter.successfulWaits,
        });
        checks.push({
          name: "runtime completed without timeout or question",
          passed: result.outcome === "ok" && !timedOut && !questionPending,
        });
        checks.push({
          name: "all observed runs completed",
          passed:
            snapshot.runs.length > 0 &&
            snapshot.runs.every((run) => run.status === "run.completed"),
        });
        checks.push({
          name: "every child has an observed inference run",
          passed: children.every((child) =>
            snapshot.runs.some((run) => run.sessionId === child.id),
          ),
        });
        checks.push({
          name: "SDK session model stayed explicit",
          passed: boundary.sessionsCreated === children.length + 1,
        });
        passed = checks.every((check) => check.passed);
        results.push({
          id: fixture.id,
          language: fixture.language,
          passed,
          outcome: result.outcome,
          timedOut,
          questionPending,
          elapsedMs: performance.now() - startedMs,
          checks,
          deniedTools: [...boundary.deniedTools],
          ...snapshot,
        });
      } catch {
        results.push({
          id: fixture.id,
          language: fixture.language,
          passed: false,
          outcome: "execution_error",
          timedOut,
          questionPending,
          elapsedMs: performance.now() - startedMs,
          deniedTools: [...boundary.deniedTools],
          ...(sessionId
            ? reporter.snapshot(
                sessionId,
                listSubagentSessions(sessionId).map((child) => child.id),
              )
            : {}),
        });
      } finally {
        if (timer) clearTimeout(timer);
        unsubscribeQuestions();
        if (sessionId) await runtime.dispose(sessionId);
        unsubscribe();
        await runtime.shutdown();
      }
      expect(passed, `${fixture.id} failed; inspect ${reportPath}`).toBe(true);
    }, 120_000);
  }
});
