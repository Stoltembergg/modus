import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { app } from "electron";
import type { ReaIntegrationState, ReaIntegrationStatus } from "../../shared/contracts";
import { createPlatformProcessOps } from "../process/platform-process-ops";
import {
  checkReaPrerequisites,
  REA_SUPPORTED_NODE_RANGE,
  type ReaPrerequisiteResult,
} from "./rea-prerequisites";
import { ReaSettingsStore } from "./rea-settings";
import { resolveReaSupervisorPath } from "./rea-supervisor-path";

export type ReaSessionOwner = { sessionId: string; generation: string };
export type ReaCatalogQuery = { query?: string; offset: number; limit: number };
export type ReaCatalogEntry = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type ReaCatalogPage = {
  offset: number;
  limit: number;
  total: number;
  tools: ReaCatalogEntry[];
};

export const MAX_REA_WORKERS = 4;
export const REA_QUEUED_CALLS_PER_WORKER = 4;
export const REA_STARTUP_TIMEOUT_MS = 180_000;
export const REA_OPERATION_TIMEOUT_MS = 600_000;
export const MAX_REA_CATALOG_PAGE_SIZE = 10;
export const MAX_REA_RESULT_BYTES = 256 * 1024;
export const MAX_REA_CATALOG_TOOLS = 512;
export const MAX_REA_CATALOG_PAGES = 64;
export const MAX_REA_CATALOG_BYTES = 4 * 1024 * 1024;
export const REA_CATALOG_TIMEOUT_MS = 60_000;

const SERVER_NAME = "modus-rea";
const SERVER_VERSION = "0.1.0";
const RESULT_TRUNCATION_MARKER = "\n[REA result truncated]";
const MAX_REA_METADATA_BYTES = 16 * 1024;
const MAX_REA_DIAGNOSTIC_BYTES = 8 * 1024;
/**
 * Curated, path-free classification patterns for captured worker stderr. Stderr is untrusted
 * data and is used only to pick a readiness state, never published in status notes.
 */
const REA_NETWORK_FAILURE_PATTERN =
  /enotfound|etimedout|econnrefused|econnreset|eai_again|getaddrinfo|fetch failed|network|offline|registry/;
const REA_MISSING_RUNTIME_PATTERN =
  /spawn (?:npx|node)(?:\.cmd|\.exe)? enoent|npx(?:\.cmd)?: command not found|node(?:\.exe)?: command not found|'(?:npx|node)(?:\.cmd|\.exe)?' is not recognized|ebadengine|unsupported engine/;
const CLEANUP_FAILURE_MESSAGE =
  "REA worker cleanup failed; the worker remains quarantined until cleanup is confirmed.";
const REA_PROVIDER_ENV = [
  "GHIDRA_INSTALL_DIR",
  "JAVA_HOME",
  "REA_ANALYSIS_PROVIDER",
  "REA_IDA_MCP_CONFIG",
  "REA_JADX_MCP_JAR",
] as const;

type ReaClient = {
  connect(transport: Transport): Promise<unknown>;
  listTools(
    params?: { cursor?: string },
    options?: { timeout?: number },
  ): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    nextCursor?: string;
  }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<CallToolResult>;
  close(): Promise<void>;
};

type ReaTransport = Transport & {
  close(): Promise<void>;
  pid?: number | null;
  stderr?: NodeJS.ReadableStream | null;
};
type ReaClientTransportFactory = {
  clientFactory: () => ReaClient;
  transportFactory: (parameters: StdioServerParameters) => ReaTransport;
};

export type ReaSessionManagerOptions = Partial<ReaClientTransportFactory> & {
  supervisorPath?: string;
  startupTimeoutMs?: number;
  operationTimeoutMs?: number;
  catalogTimeoutMs?: number;
  platform?: NodeJS.Platform;
  platformProcessOps?: PlatformProcessOps;
  userDataDirectory?: string;
  /** Explicit REA root override for tests; defaults to `<userData>/rea`. */
  tempDirectory?: string;
  settingsStore?: ReaSettingsStore;
  checkPrerequisites?: () => Promise<ReaPrerequisiteResult>;
  /** Test seam for the once-per-instance stale worker-directory sweep. */
  removeWorkerDirectory?: (directory: string) => void;
};

export type PlatformProcessOps = {
  /** POSIX supervisor PID is also its process-group ID. Windows cleanup is Job Object-owned. */
  killTree(pid: number): Promise<void> | void;
};

type Worker = {
  owner: ReaSessionOwner;
  key: string;
  retired: boolean;
  /** Set by dispose/disable/cancel paths so a cancelled startup skips failure classification. */
  externallyRetired?: boolean;
  /** Count of in-flight readiness acquisitions (connect + catalog) for this worker. */
  readinessPending?: number;
  client?: ReaClient;
  transport?: ReaTransport;
  workingDirectory?: string;
  startup?: Promise<void>;
  catalog?: Promise<ReaCatalogEntry[]>;
  tools?: ReaCatalogEntry[];
  callActive: boolean;
  callQueue: Array<{
    owner: ReaSessionOwner;
    operation: string;
    args: Record<string, unknown>;
    resolve: (result: CallToolResult) => void;
    reject: (error: unknown) => void;
  }>;
  cancelled: Promise<void>;
  cancel: () => void;
  closePromise?: Promise<void>;
  supervisorPid?: number;
  processCleanup?: Promise<void>;
  transportCloseHandled: boolean;
  diagnostics?: { chunks: string[]; bytes: number };
};

/** A prerequisite probe failure that must surface as its own readiness state, not `failed`. */
class ReaStartupError extends Error {
  constructor(
    readonly status: "needs_node" | "network_error" | "failed",
    readonly note: string,
  ) {
    super(note);
    this.name = "ReaStartupError";
  }
}

function ownerKey(owner: ReaSessionOwner): string {
  return JSON.stringify([owner.sessionId, owner.generation]);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function safeEnvironment(npmCacheDirectory: string): Record<string, string> {
  const allowed = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "ComSpec",
  ];
  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const key of REA_PROVIDER_ENV) {
    const value = process.env[key];
    if (value?.trim()) env[key] = value;
  }
  env.npm_config_cache = npmCacheDirectory;
  return env;
}

function normalizeTools(tools: ReaCatalogEntry[]): ReaCatalogEntry[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function boundedResult(result: CallToolResult): CallToolResult {
  const serialized = jsonByteLength(result);
  if (serialized <= MAX_REA_RESULT_BYTES) return result;

  const bounded: Record<string, unknown> = {};
  if (typeof result.isError === "boolean") bounded.isError = result.isError;
  if (jsonByteLength(result._meta) <= MAX_REA_METADATA_BYTES) {
    if (result._meta !== undefined) bounded._meta = result._meta;
  }
  if (jsonByteLength(result.structuredContent) <= MAX_REA_METADATA_BYTES) {
    if (result.structuredContent !== undefined)
      bounded.structuredContent = result.structuredContent;
  }
  const field = (value: unknown): string => (typeof value === "string" ? value.slice(0, 512) : "");
  const unknownMarker = "[REA content block omitted: unknown or future block type]";
  const rendered = result.content.map((item) => {
    switch (item.type) {
      case "text":
        return item.text;
      case "image":
        return `[Image omitted; mimeType=${field(item.mimeType) || "unknown"}; base64 data omitted]`;
      case "audio":
        return `[Audio omitted; mimeType=${field(item.mimeType) || "unknown"}; base64 data omitted]`;
      case "resource_link":
        return `[Resource link metadata; uri=${field(item.uri)}; name=${field(item.name)}; mimeType=${field(item.mimeType)}; description=${field(item.description)}]`;
      case "resource":
        return "text" in item.resource
          ? `[Embedded resource text; uri=${field(item.resource.uri)}; mimeType=${field(item.resource.mimeType)}]\n${item.resource.text}`
          : `[Embedded resource omitted; uri=${field(item.resource.uri)}; mimeType=${field(item.resource.mimeType)}; blob data omitted]`;
      default:
        return unknownMarker;
    }
  });
  if (rendered.includes(unknownMarker)) rendered.unshift(unknownMarker);
  const text = rendered.join("\n\n");
  const base = {
    ...bounded,
    content: [{ type: "text", text: RESULT_TRUNCATION_MARKER.trimStart() }],
  };
  let low = 0;
  let high = text.length;
  let best = base;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    let prefix = text.slice(0, midpoint);
    if (prefix.length > 0 && /[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    const candidate = {
      ...bounded,
      content: [{ type: "text", text: `${prefix}${RESULT_TRUNCATION_MARKER}` }],
    };
    if (jsonByteLength(candidate) <= MAX_REA_RESULT_BYTES) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best as unknown as CallToolResult;
}

function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

export class ReaSessionManager {
  private readonly workers = new Map<string, Worker>();
  private readonly activeGenerations = new Map<string, string>();
  private readonly retiredOwners = new Set<string>();
  private readonly clientFactory: () => ReaClient;
  private readonly transportFactory: (parameters: StdioServerParameters) => ReaTransport;
  private readonly supervisorPath: string | undefined;
  private readonly startupTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly catalogTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly platformProcessOps: PlatformProcessOps | undefined;
  private readonly reaDirectory: string;
  private readonly workersDirectory: string;
  private readonly npmCacheDirectory: string;
  private readonly settingsStore: ReaSettingsStore;
  private readonly checkPrerequisites: () => Promise<ReaPrerequisiteResult>;
  private readonly removeWorkerDirectory: (directory: string) => void;
  private lifecycleStatus: ReaIntegrationState = "not_started";
  private lifecycleNote: string | undefined;
  private sweptStaleWorkerDirectories = false;

  constructor(options: ReaSessionManagerOptions = {}) {
    this.clientFactory =
      options.clientFactory ??
      (() => new Client({ name: SERVER_NAME, version: SERVER_VERSION }) as unknown as ReaClient);
    this.transportFactory =
      options.transportFactory ??
      ((parameters) => new StdioClientTransport(parameters) as ReaTransport);
    this.supervisorPath = options.supervisorPath;
    this.startupTimeoutMs = options.startupTimeoutMs ?? REA_STARTUP_TIMEOUT_MS;
    this.operationTimeoutMs = options.operationTimeoutMs ?? REA_OPERATION_TIMEOUT_MS;
    this.catalogTimeoutMs = options.catalogTimeoutMs ?? REA_CATALOG_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
    this.platformProcessOps =
      this.platform === "win32"
        ? undefined
        : (options.platformProcessOps ?? createPlatformProcessOps(this.platform));
    this.reaDirectory =
      options.tempDirectory ?? join(options.userDataDirectory ?? app.getPath("userData"), "rea");
    this.workersDirectory = join(this.reaDirectory, "workers");
    this.npmCacheDirectory = join(this.reaDirectory, "npm-cache");
    this.settingsStore = options.settingsStore ?? new ReaSettingsStore();
    this.checkPrerequisites =
      options.checkPrerequisites ?? (() => checkReaPrerequisites({ platform: this.platform }));
    this.removeWorkerDirectory =
      options.removeWorkerDirectory ??
      ((directory) => rmSync(directory, { recursive: true, force: true }));
  }

  getIntegrationStatus(): ReaIntegrationStatus {
    const settings = this.settingsStore.get();
    const providerNotes = this.getProviderNotes();
    if (settings.settingsError) {
      return {
        enabled: false,
        status: "failed",
        note: "REA settings could not be read. Check the user-level Modus settings file.",
        providerNotes,
        settingsError: true,
      };
    }
    if (!settings.enabled) {
      if (
        this.lifecycleStatus === "failed" &&
        this.lifecycleNote === "REA worker cleanup could not be confirmed."
      ) {
        return {
          enabled: false,
          status: "failed",
          note: this.lifecycleNote,
          providerNotes,
        };
      }
      return {
        enabled: false,
        status: "disabled",
        note: "REA is disabled in Modus settings.",
        providerNotes,
      };
    }
    if (this.hasReadyWorker()) {
      return { enabled: true, status: "ready", providerNotes };
    }
    if (this.hasStartingWorker()) {
      // A worker is still connecting or loading its initial catalog.
      return { enabled: true, status: "starting", providerNotes };
    }
    if (this.lifecycleStatus === "starting") {
      // Every startup was cancelled (disposal/disable) and none is in flight: stay lazy.
      return { enabled: true, status: "not_started", providerNotes };
    }
    return {
      enabled: true,
      status: this.lifecycleStatus === "ready" ? "not_started" : this.lifecycleStatus,
      ...(this.lifecycleStatus === "ready"
        ? {}
        : this.lifecycleNote
          ? { note: this.lifecycleNote }
          : {}),
      providerNotes,
    };
  }

  private hasReadyWorker(): boolean {
    return [...this.workers.values()].some(
      (worker) => !worker.retired && worker.tools !== undefined,
    );
  }

  private hasStartingWorker(): boolean {
    return [...this.workers.values()].some(
      (worker) => !worker.retired && (worker.readinessPending ?? 0) > 0,
    );
  }

  private getProviderNotes(): string[] {
    const notes: string[] = [];
    if (this.platform === "win32") notes.push("Ghidra provider is unsupported on this host.");
    if (!process.env.REA_IDA_MCP_CONFIG?.trim()) {
      notes.push("IDA provider requires a user installation and configuration.");
    }
    if (!process.env.REA_JADX_MCP_JAR?.trim()) {
      notes.push("JADX provider requires a user installation and configuration.");
    }
    return notes;
  }

  async setEnabled(enabled: boolean): Promise<ReaIntegrationStatus> {
    this.settingsStore.setEnabled(enabled);
    if (!enabled) {
      this.lifecycleStatus = "disabled";
      this.lifecycleNote = "REA is disabled in Modus settings.";
      const workers = [...this.workers.values()];
      const results = await Promise.allSettled(
        workers.map((worker) => this.retireWorker(worker, true)),
      );
      if (results.some((result) => result.status === "rejected")) {
        this.lifecycleStatus = "failed";
        this.markCleanupFailure();
      }
    } else {
      this.lifecycleStatus = "not_started";
      this.lifecycleNote = undefined;
    }
    return this.getIntegrationStatus();
  }

  retry(): ReaIntegrationStatus {
    const settings = this.settingsStore.get();
    if (!settings.settingsError && settings.enabled) {
      this.lifecycleStatus = "not_started";
      this.lifecycleNote = undefined;
    }
    return this.getIntegrationStatus();
  }

  async listTools(owner: ReaSessionOwner, query: ReaCatalogQuery): Promise<ReaCatalogPage> {
    this.assertEnabled();
    const worker = this.getWorker(owner);
    await this.ensureCatalog(worker);
    this.assertCurrent(owner, worker);
    this.markReady();
    const search = query.query?.trim().toLocaleLowerCase();
    const filtered = (worker.tools ?? []).filter(
      (tool) =>
        !search ||
        tool.name.toLocaleLowerCase().includes(search) ||
        tool.description.toLocaleLowerCase().includes(search),
    );
    const offset = Math.max(0, Math.trunc(Number.isFinite(query.offset) ? query.offset : 0));
    const limit = Math.max(
      1,
      Math.min(
        MAX_REA_CATALOG_PAGE_SIZE,
        Math.trunc(Number.isFinite(query.limit) ? query.limit : MAX_REA_CATALOG_PAGE_SIZE),
      ),
    );
    return { offset, limit, total: filtered.length, tools: filtered.slice(offset, offset + limit) };
  }

  async callTool(
    owner: ReaSessionOwner,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    this.assertEnabled();
    const worker = this.getWorker(owner);
    await this.ensureCatalog(worker);
    this.assertCurrent(owner, worker);
    this.markReady();
    if (!(worker.tools ?? []).some((tool) => tool.name === operation)) {
      throw new Error(`Unknown REA operation: ${operation}`);
    }
    if (worker.callActive && worker.callQueue.length >= REA_QUEUED_CALLS_PER_WORKER) {
      throw new Error("REA worker is busy; retry the call later.");
    }
    return new Promise<CallToolResult>((resolve, reject) => {
      worker.callQueue.push({ owner: { ...owner }, operation, args, resolve, reject });
      void this.pumpCallQueue(worker);
    });
  }

  async disposeSession(owner: ReaSessionOwner): Promise<void> {
    const key = ownerKey(owner);
    this.retiredOwners.add(key);
    if (this.activeGenerations.get(owner.sessionId) === owner.generation) {
      this.activeGenerations.delete(owner.sessionId);
    }
    const worker = this.workers.get(key);
    if (worker) await this.retireWorker(worker, true);
  }

  /** Retire the current worker after an uncertain operation without retiring its owner generation. */
  async cancel(owner: ReaSessionOwner): Promise<void> {
    const worker = this.workers.get(ownerKey(owner));
    if (!worker) return;
    this.markUncertainFailure();
    try {
      await this.retireWorker(worker, true);
    } catch (error) {
      this.markCleanupFailure();
      throw error;
    }
  }

  async disposeAll(): Promise<void> {
    const workers = [...this.workers.values()];
    for (const [sessionId, generation] of this.activeGenerations) {
      this.retiredOwners.add(ownerKey({ sessionId, generation }));
    }
    this.activeGenerations.clear();
    for (const worker of workers) {
      this.retiredOwners.add(worker.key);
    }
    await Promise.all(workers.map((worker) => this.retireWorker(worker, true)));
  }

  private getWorker(owner: ReaSessionOwner): Worker {
    this.assertGeneration(owner);
    const key = ownerKey(owner);
    const existing = this.workers.get(key);
    if (existing) {
      if (!existing.retired) return existing;
      throw new Error("REA worker is closing; retry after cleanup completes.");
    }
    if (this.workers.size >= MAX_REA_WORKERS) {
      throw new Error("REA worker capacity is busy; retry after another session closes.");
    }
    let cancelWorker!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancelWorker = resolve;
    });
    const worker: Worker = {
      owner: { ...owner },
      key,
      retired: false,
      callActive: false,
      callQueue: [],
      transportCloseHandled: false,
      cancelled,
      cancel: cancelWorker,
    };
    this.workers.set(key, worker);
    return worker;
  }

  private assertGeneration(owner: ReaSessionOwner): void {
    const key = ownerKey(owner);
    if (this.retiredOwners.has(key)) throw new Error("Stale or disposed REA session generation.");
    const active = this.activeGenerations.get(owner.sessionId);
    if (active && active !== owner.generation) {
      throw new Error("Stale REA session generation.");
    }
    if (!active) this.activeGenerations.set(owner.sessionId, owner.generation);
  }

  private assertEnabled(): void {
    const settings = this.settingsStore.get();
    if (settings.settingsError)
      throw new Error("REA settings are invalid; REA is unavailable until they are repaired.");
    if (!settings.enabled) throw new Error("REA is disabled in Modus settings.");
  }

  private markReady(): void {
    this.lifecycleStatus = "ready";
    this.lifecycleNote = undefined;
  }

  private assertCurrent(owner: ReaSessionOwner, worker: Worker): void {
    this.assertGeneration(owner);
    if (worker.retired || this.workers.get(worker.key) !== worker) {
      throw new Error("Stale or disposed REA session generation.");
    }
  }

  private ensureStarted(worker: Worker): Promise<void> {
    if (worker.startup) return worker.startup;
    this.lifecycleStatus = "starting";
    this.lifecycleNote = undefined;
    worker.startup = this.startWorker(worker);
    return worker.startup;
  }

  /**
   * Removes per-session working directories left behind by a previous, non-graceful
   * exit. Runs at most once per manager instance and only before the first worker
   * directory is created, so it can never delete a directory this manager still owns.
   */
  private sweepStaleWorkerDirectories(): void {
    if (this.sweptStaleWorkerDirectories) return;
    this.sweptStaleWorkerDirectories = true;
    let entries: string[];
    try {
      entries = readdirSync(this.workersDirectory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith("worker-")) continue;
      try {
        this.removeWorkerDirectory(join(this.workersDirectory, entry));
      } catch {
        // Best effort: a leftover directory must never block starting a worker.
      }
    }
  }

  private async startWorker(worker: Worker): Promise<void> {
    try {
      const prerequisite = await this.checkPrerequisites();
      // The probe is an await point: a disposal, disable, or generation change may have
      // retired this worker while it ran. Bail out before allocating anything so a
      // cancelled startup can never leave an orphan worker behind.
      this.assertCurrent(worker.owner, worker);
      if (!prerequisite.ok) {
        throw new ReaStartupError(prerequisite.status, prerequisite.note);
      }
      ensurePrivateDirectory(this.reaDirectory);
      ensurePrivateDirectory(this.workersDirectory);
      ensurePrivateDirectory(this.npmCacheDirectory);
      this.sweepStaleWorkerDirectories();
      worker.workingDirectory = mkdtempSync(join(this.workersDirectory, "worker-"));
      const client = this.clientFactory();
      const transport = this.transportFactory({
        command: this.supervisorPath ?? resolveReaSupervisorPath(),
        args: [],
        env: safeEnvironment(this.npmCacheDirectory),
        cwd: worker.workingDirectory,
        stderr: "pipe",
      });
      worker.client = client;
      worker.transport = transport;
      this.captureWorkerDiagnostics(worker, transport);
      const previousOnClose = transport.onclose;
      transport.onclose = () => {
        try {
          previousOnClose?.();
        } finally {
          this.handleTransportClose(worker);
        }
      };
      const connecting = client.connect(transport);
      if (transport.pid && transport.pid > 0) worker.supervisorPid = transport.pid;
      void connecting.then(
        () => {
          if (worker.retired) void this.closeWorkerResources(worker);
        },
        () => {},
      );
      await Promise.race([
        withTimeout(connecting, this.startupTimeoutMs, "REA worker startup"),
        worker.cancelled.then(() => {
          throw new Error("REA worker startup was cancelled because its session was disposed.");
        }),
      ]);
      if (transport.pid && transport.pid > 0) worker.supervisorPid = transport.pid;
      this.assertCurrent(worker.owner, worker);
    } catch (error) {
      const current = this.workers.get(worker.key);
      const superseded = current !== undefined && current !== worker;
      // Classify real startup failures even when the worker was already retired by its own
      // transport closing (the SDK emits close before rejecting connect). Only an external
      // dispose/disable/cancel, or a newer worker for the same key, suppresses classification.
      if (!worker.externallyRetired && !superseded) {
        this.setFailureStatus(error, worker);
      }
      await this.retireWorker(worker);
      throw error;
    }
  }

  private captureWorkerDiagnostics(worker: Worker, transport: ReaTransport): void {
    const stream = transport.stderr;
    if (!stream || typeof stream.on !== "function") return;
    const diagnostics = { chunks: [] as string[], bytes: 0 };
    worker.diagnostics = diagnostics;
    stream.on("data", (chunk: unknown) => {
      if (diagnostics.bytes >= MAX_REA_DIAGNOSTIC_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      const bounded = buffer.subarray(0, MAX_REA_DIAGNOSTIC_BYTES - diagnostics.bytes);
      diagnostics.chunks.push(bounded.toString("utf8"));
      diagnostics.bytes += bounded.byteLength;
    });
    stream.on("error", () => {});
  }

  private setFailureStatus(error: unknown, worker?: Worker): void {
    if (error instanceof ReaStartupError) {
      this.lifecycleStatus = error.status;
      this.lifecycleNote = error.note;
      return;
    }
    const diagnostic = worker?.diagnostics ? worker.diagnostics.chunks.join("").toLowerCase() : "";
    const message = `${error instanceof Error ? error.message : ""} ${diagnostic}`.toLowerCase();
    if (REA_NETWORK_FAILURE_PATTERN.test(message)) {
      this.lifecycleStatus = "network_error";
      this.lifecycleNote =
        "REA could not acquire or connect to its pinned package; check network access and retry.";
    } else if (REA_MISSING_RUNTIME_PATTERN.test(message)) {
      this.lifecycleStatus = "needs_node";
      this.lifecycleNote = `REA needs Node.js ${REA_SUPPORTED_NODE_RANGE} and npm. Install a supported runtime and retry.`;
    } else {
      this.lifecycleStatus = "failed";
      this.lifecycleNote =
        "REA could not start. Retry after checking Node.js, npm, and network availability.";
    }
  }

  private async ensureCatalog(worker: Worker): Promise<void> {
    // Reference-counted so a concurrent caller's settlement can never clear another caller's
    // in-flight readiness. Covers connect + (re)acquiring the catalog.
    worker.readinessPending = (worker.readinessPending ?? 0) + 1;
    try {
      this.assertCurrent(worker.owner, worker);
      await this.ensureStarted(worker);
      this.assertCurrent(worker.owner, worker);
      if (!worker.catalog) {
        worker.catalog = this.loadCatalog(worker);
      }
      const catalog = worker.catalog;
      try {
        await catalog;
      } catch (error) {
        if (worker.catalog === catalog && !worker.retired) delete worker.catalog;
        // Mirror the startup discipline: suppress only an externally retired or superseded
        // worker, so an internally-retired catalog timeout still publishes its failure.
        const current = this.workers.get(worker.key);
        const superseded = current !== undefined && current !== worker;
        if (!worker.externallyRetired && !superseded) this.setFailureStatus(error);
        throw error;
      }
      this.assertCurrent(worker.owner, worker);
    } finally {
      worker.readinessPending = Math.max(0, (worker.readinessPending ?? 1) - 1);
    }
  }

  private async loadCatalog(worker: Worker): Promise<ReaCatalogEntry[]> {
    const client = worker.client;
    if (!client) throw new Error("REA worker is not connected.");
    const tools: ReaCatalogEntry[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let pageCount = 0;
    let descriptorBytes = 2;
    const catalogDeadline = Date.now() + this.catalogTimeoutMs;
    do {
      if (pageCount >= MAX_REA_CATALOG_PAGES) {
        throw new Error(`REA catalog exceeded the ${MAX_REA_CATALOG_PAGES}-page limit.`);
      }
      pageCount++;
      const remainingMs = catalogDeadline - Date.now();
      if (remainingMs <= 0) {
        await this.retireWorker(worker);
        throw new Error(`REA catalog total duration timed out after ${this.catalogTimeoutMs}ms.`);
      }
      const pageTimeoutMs = Math.min(this.operationTimeoutMs, remainingMs);
      const listRequest = client.listTools(cursor ? { cursor } : undefined, {
        timeout: pageTimeoutMs,
      });
      let page: Awaited<typeof listRequest>;
      try {
        page = await Promise.race([
          withTimeout(listRequest, pageTimeoutMs, "REA catalog total duration"),
          worker.cancelled.then(() => {
            throw new Error("REA catalog request was cancelled because its session was disposed.");
          }),
        ]);
      } catch (error) {
        if (error instanceof Error && /timed out/i.test(error.message)) {
          await this.retireWorker(worker);
        }
        throw error;
      }
      if (tools.length + page.tools.length > MAX_REA_CATALOG_TOOLS) {
        throw new Error(`REA catalog exceeded the ${MAX_REA_CATALOG_TOOLS}-tool limit.`);
      }
      for (const tool of page.tools) {
        const inputSchema =
          typeof tool.inputSchema === "object" &&
          tool.inputSchema !== null &&
          !Array.isArray(tool.inputSchema)
            ? (tool.inputSchema as Record<string, unknown>)
            : {};
        const entry = {
          name: tool.name,
          description: tool.description ?? "",
          inputSchema,
        };
        descriptorBytes += jsonByteLength(entry) + (tools.length > 0 ? 1 : 0);
        if (descriptorBytes > MAX_REA_CATALOG_BYTES) {
          throw new Error(
            `REA catalog exceeded the ${MAX_REA_CATALOG_BYTES}-byte descriptor limit.`,
          );
        }
        tools.push(entry);
      }
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor))
        throw new Error("REA returned a repeated catalog cursor.");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    this.assertCurrent(worker.owner, worker);
    worker.tools = normalizeTools(tools);
    return worker.tools;
  }

  private async pumpCallQueue(worker: Worker): Promise<void> {
    if (worker.callActive || worker.retired) return;
    const queued = worker.callQueue.shift();
    if (!queued) return;
    worker.callActive = true;
    try {
      this.assertCurrent(queued.owner, worker);
      const client = worker.client;
      if (!client) throw new Error("REA worker is not connected.");
      const operationCall = client.callTool(
        { name: queued.operation, arguments: queued.args },
        undefined,
        { timeout: this.operationTimeoutMs },
      );
      const result = await Promise.race([
        withTimeout(operationCall, this.operationTimeoutMs, "REA operation"),
        worker.cancelled.then(() => {
          throw new Error("REA operation was cancelled because its session was disposed.");
        }),
      ]);
      this.assertCurrent(queued.owner, worker);
      queued.resolve(boundedResult(result));
    } catch (error) {
      let rejection = error;
      if (error instanceof Error && /timed out/i.test(error.message)) {
        this.markUncertainFailure();
        try {
          await this.retireWorker(worker);
        } catch {
          this.markCleanupFailure();
          rejection = new Error(CLEANUP_FAILURE_MESSAGE);
        }
      }
      queued.reject(rejection);
    } finally {
      worker.callActive = false;
      void this.pumpCallQueue(worker);
    }
  }

  private async retireWorker(worker: Worker, externallyRetired = false): Promise<void> {
    if (externallyRetired) worker.externallyRetired = true;
    if (!worker.retired) {
      worker.retired = true;
      worker.cancel();
    }
    const queuedError = new Error("Stale or disposed REA session generation.");
    for (const queued of worker.callQueue.splice(0)) queued.reject(queuedError);
    await this.closeWorkerResources(worker);
    if (this.workers.get(worker.key) === worker) this.workers.delete(worker.key);
  }

  private closeWorkerResources(worker: Worker): Promise<void> {
    if (worker.closePromise) return worker.closePromise;
    const closing = (async () => {
      await Promise.all([
        worker.client?.close().catch(() => {}),
        worker.transport?.close().catch(() => {}),
      ]);
      await this.cleanupProcessGroup(worker);
      if (worker.workingDirectory) {
        rmSync(worker.workingDirectory, { recursive: true, force: true });
        delete worker.workingDirectory;
      }
    })();
    const retryable = closing.catch(() => {
      if (worker.closePromise === retryable) delete worker.closePromise;
      delete worker.processCleanup;
      throw new Error(CLEANUP_FAILURE_MESSAGE);
    });
    worker.closePromise = retryable;
    return worker.closePromise;
  }

  private handleTransportClose(worker: Worker): void {
    if (worker.transportCloseHandled) return;
    worker.transportCloseHandled = true;
    if (this.workers.get(worker.key) === worker && !worker.retired) {
      this.markUncertainFailure();
      void this.retireWorker(worker).catch(() => {});
    } else {
      void this.cleanupProcessGroup(worker).catch(() => {});
    }
  }

  private markUncertainFailure(): void {
    this.lifecycleStatus = "failed";
    this.lifecycleNote = "REA connection was interrupted. Retry before the next approved call.";
  }

  private markCleanupFailure(): void {
    this.lifecycleStatus = "failed";
    this.lifecycleNote = "REA worker cleanup could not be confirmed.";
  }

  private cleanupProcessGroup(worker: Worker): Promise<void> {
    if (worker.processCleanup) return worker.processCleanup;
    if (this.platform === "win32" || worker.supervisorPid === undefined) {
      worker.processCleanup = Promise.resolve();
      return worker.processCleanup;
    }
    const pid = worker.supervisorPid;
    const processOps = this.platformProcessOps;
    if (!processOps) throw new Error("POSIX REA process-tree cleanup is unavailable.");
    worker.processCleanup = Promise.resolve().then(() => processOps.killTree(pid));
    return worker.processCleanup;
  }
}
