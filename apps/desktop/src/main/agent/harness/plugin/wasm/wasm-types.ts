/**
 * @file wasm-types.ts
 * Core contracts for Fase 19 — High-Performance Sandboxing (WASM & Micro-VMs).
 */

export class WasmFuelExhaustedError extends Error {
  constructor(
    public readonly fuelLimit: bigint,
    public readonly fuelBurned: bigint,
    public readonly pluginId?: string,
  ) {
    super(
      `WASM execution fuel exhausted (limit: ${fuelLimit.toString()}, burned: ${fuelBurned.toString()})${
        pluginId ? ` in plugin "${pluginId}"` : ""
      }`,
    );
    this.name = "WasmFuelExhaustedError";
  }
}

export class WasmMemoryOutOfBoundsError extends Error {
  constructor(
    public readonly requestedBytes: number,
    public readonly maxAllowedBytes: number,
    public readonly pluginId?: string,
  ) {
    super(
      `WASM memory access out of bounds: requested ${requestedBytes} bytes, max allowed is ${maxAllowedBytes} bytes${
        pluginId ? ` for plugin "${pluginId}"` : ""
      }`,
    );
    this.name = "WasmMemoryOutOfBoundsError";
  }
}

export class WasmMemoryPolicyError extends Error {
  constructor(
    message: string,
    public readonly pluginId?: string,
  ) {
    super(`${message}${pluginId ? ` for plugin "${pluginId}"` : ""}`);
    this.name = "WasmMemoryPolicyError";
  }
}

export class WasmExecutionTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly pluginId?: string,
  ) {
    super(
      `WASM execution timed out after ${timeoutMs}ms${pluginId ? ` for plugin "${pluginId}"` : ""}`,
    );
    this.name = "WasmExecutionTimeoutError";
  }
}

export class WasmCompilationError extends Error {
  constructor(
    public readonly originalMessage: string,
    public readonly moduleName?: string,
  ) {
    super(
      `Failed to compile WASM module${moduleName ? ` "${moduleName}"` : ""}: ${originalMessage}`,
    );
    this.name = "WasmCompilationError";
  }
}

export interface WasmFuelConfig {
  initialFuel: bigint;
  costPerCall?: bigint | undefined;
  costPerByte?: bigint | undefined;
  costPerLoopIteration?: bigint | undefined;
}

export interface WasmMemoryConfig {
  /**
   * Initial pages for a host-created imported memory. Module-defined memory
   * uses the initial size declared by the module binary.
   */
  initialPages: number;
  /** Maximum pages allowed by this instance. Defined memories must declare a
   * maximum no greater than this value; imported memories are created at this cap. */
  maxPages: number;
}

export interface WasiOptions {
  enabled?: boolean | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  preopens?: Record<string, string> | undefined;
  captureStdout?: boolean | undefined;
  captureStderr?: boolean | undefined;
}

export interface WasmInstanceOptions {
  pluginId?: string | undefined;
  fuel?: WasmFuelConfig | undefined;
  memory?: WasmMemoryConfig | undefined;
  wasi?: WasiOptions | undefined;
  timeoutMs?: number | undefined;
  hostImports?: Record<string, Record<string, WebAssembly.ImportValue>> | undefined;
}

export interface WasmCapabilityHostOptions {
  /** Maximum memory pages reserved by one instance. Defaults to 256 (16 MiB). */
  maxMemoryPagesPerInstance?: number | undefined;
  /** Maximum simultaneously reserved memory pages. Defaults to 1024 (64 MiB). */
  maxAggregateMemoryPages?: number | undefined;
  /** Maximum number of compiled modules retained in the LRU cache. Defaults to 64. */
  maxCachedModules?: number | undefined;
  /** Maximum source-WASM bytes represented by cached modules. Defaults to 16 MiB. */
  maxCachedModuleSourceBytes?: number | undefined;
}

export interface WasmExecutionMetrics {
  latencyMs: number;
  fuelConsumed: bigint;
  fuelRemaining: bigint;
  memoryPagesUsed: number;
  memoryBytesUsed: number;
  /** False when instantiation failed before the host could observe a defined memory. */
  memoryUsageAvailable: boolean;
}

export interface WasmExecutionResult<T = unknown> {
  success: boolean;
  result?: T | undefined;
  error?: string | undefined;
  metrics: WasmExecutionMetrics;
  stdout?: string | undefined;
  stderr?: string | undefined;
}

export interface WasmModuleInspection {
  exportedFunctions: string[];
  exportedGlobals: string[];
  importedModules: Array<{ module: string; name: string; kind: string }>;
  memoryConfig?: { initial: number; maximum?: number } | undefined;
  wasiDetected: boolean;
}
