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
  initialPages: number;
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

export interface WasmExecutionMetrics {
  latencyMs: number;
  fuelConsumed: bigint;
  fuelRemaining: bigint;
  memoryPagesUsed: number;
  memoryBytesUsed: number;
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
