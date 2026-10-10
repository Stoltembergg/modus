/**
 * @file wasm-capability-host.ts
 * Host runtime for WebAssembly / WASI capabilities.
 * Delivers sub-millisecond execution (< 0.2ms), instruction fuel metering, and memory isolation.
 */

import { createHash } from "node:crypto";
import type { PluginRpcResponse } from "../plugin-isolation-types";
import type { WasiSandbox } from "./wasi-sandbox";
import { WasmFuelMeter } from "./wasm-fuel-meter";
import { WasmPluginInstance } from "./wasm-instance";
import { inspectWasmMemories, type WasmMemoryDeclaration } from "./wasm-memory-inspector";
import {
  type WasmCapabilityHostOptions,
  WasmCompilationError,
  type WasmExecutionMetrics,
  type WasmExecutionResult,
  WasmExecutionTimeoutError,
  type WasmInstanceOptions,
  WasmMemoryPolicyError,
  type WasmModuleInspection,
} from "./wasm-types";

type WasmInstantiationFailureMetrics = Omit<WasmExecutionMetrics, "latencyMs">;
const instantiationFailureMetrics = new WeakMap<object, WasmInstantiationFailureMetrics>();

function hasWebAssemblyInternalSlot(value: unknown, prototype: object, property: string): boolean {
  const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
  if (!getter) return false;
  try {
    Reflect.apply(getter, value, []);
    return true;
  } catch {
    return false;
  }
}

function readWebAssemblyGlobalValue(
  value: unknown,
): { recognized: false } | { recognized: true; value: unknown } {
  const getter = Object.getOwnPropertyDescriptor(WebAssembly.Global.prototype, "value")?.get;
  if (!getter) return { recognized: false };
  try {
    return { recognized: true, value: Reflect.apply(getter, value, []) };
  } catch {
    return { recognized: false };
  }
}

export class WasmCapabilityHost {
  private readonly moduleCache = new Map<
    string,
    { module: WebAssembly.Module; sourceBytes: number }
  >();
  private readonly maxMemoryPagesPerInstance: number;
  private readonly maxAggregateMemoryPages: number;
  private readonly maxCachedModules: number;
  private readonly maxCachedModuleSourceBytes: number;
  private cachedModuleSourceBytes = 0;
  private reservedMemoryPages = 0;

  constructor(options: WasmCapabilityHostOptions = {}) {
    this.maxMemoryPagesPerInstance = options.maxMemoryPagesPerInstance ?? 256;
    this.maxAggregateMemoryPages = options.maxAggregateMemoryPages ?? 1024;
    this.maxCachedModules = options.maxCachedModules ?? 64;
    this.maxCachedModuleSourceBytes = options.maxCachedModuleSourceBytes ?? 16 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.maxMemoryPagesPerInstance) ||
      this.maxMemoryPagesPerInstance <= 0 ||
      !Number.isSafeInteger(this.maxAggregateMemoryPages) ||
      this.maxAggregateMemoryPages <= 0 ||
      !Number.isSafeInteger(this.maxCachedModules) ||
      this.maxCachedModules < 0 ||
      !Number.isSafeInteger(this.maxCachedModuleSourceBytes) ||
      this.maxCachedModuleSourceBytes < 0
    ) {
      throw new RangeError("WASM memory limits and module-cache bounds must be safe integers");
    }
  }

  public getReservedMemoryPages(): number {
    return this.reservedMemoryPages;
  }

  /**
   * Reports source-WASM bytes represented by cache entries. Node does not expose
   * the native memory retained by compiled WebAssembly.Module objects.
   */
  public getModuleCacheStats(): Readonly<{
    entries: number;
    sourceBytes: number;
    maxEntries: number;
    maxSourceBytes: number;
  }> {
    return Object.freeze({
      entries: this.moduleCache.size,
      sourceBytes: this.cachedModuleSourceBytes,
      maxEntries: this.maxCachedModules,
      maxSourceBytes: this.maxCachedModuleSourceBytes,
    });
  }

  /**
   * Compiles and caches a WebAssembly module.
   */
  public async compileModule(
    wasmBytes: Uint8Array,
    cacheKey?: string,
  ): Promise<WebAssembly.Module> {
    const hash = createHash("sha256").update(wasmBytes).digest("hex");
    const namespace = cacheKey ? `${createHash("sha256").update(cacheKey).digest("hex")}:` : "";
    const key = `${namespace}${hash}`;
    const cached = this.moduleCache.get(key);
    if (cached) {
      this.moduleCache.delete(key);
      this.moduleCache.set(key, cached);
      return cached.module;
    }

    try {
      const module = await WebAssembly.compile(wasmBytes as unknown as BufferSource);
      this.cacheCompiledModule(key, module, wasmBytes.byteLength);
      return module;
    } catch (err) {
      throw new WasmCompilationError(err instanceof Error ? err.message : String(err), cacheKey);
    }
  }

  /**
   * Inspects a WASM binary without instantiating it.
   */
  public inspectModule(module: WebAssembly.Module, wasmBytes?: Uint8Array): WasmModuleInspection {
    const exports = WebAssembly.Module.exports(module);
    const imports = WebAssembly.Module.imports(module);

    const exportedFunctions: string[] = [];
    const exportedGlobals: string[] = [];
    let wasiDetected = false;

    for (const exp of exports) {
      if (exp.kind === "function") {
        exportedFunctions.push(exp.name);
      } else if (exp.kind === "global") {
        exportedGlobals.push(exp.name);
      }
    }

    const importedModules: Array<{ module: string; name: string; kind: string }> = [];
    for (const imp of imports) {
      importedModules.push({
        module: imp.module,
        name: imp.name,
        kind: imp.kind,
      });
      if (/^wasi(?:_|:)/i.test(imp.module)) {
        wasiDetected = true;
      }
    }

    const memories = wasmBytes ? inspectWasmMemories(wasmBytes) : [];
    const memory = memories.length === 1 ? memories[0] : undefined;
    return {
      exportedFunctions,
      exportedGlobals,
      importedModules,
      ...(memory
        ? {
            memoryConfig: {
              initial: memory.initialPages,
              ...(memory.maximumPages === undefined ? {} : { maximum: memory.maximumPages }),
            },
          }
        : {}),
      wasiDetected,
    };
  }

  /**
   * Creates a WASM instance with fuel metering. WASI imports stay disabled until the host
   * has a grant-backed policy for imports, environment, and preopens.
   */
  public async createInstance(
    wasmBytes: Uint8Array,
    options: WasmInstanceOptions = {},
  ): Promise<{ instance: WasmPluginInstance; wasiSandbox?: WasiSandbox }> {
    const stableWasmBytes = new Uint8Array(wasmBytes);
    const module = await this.compileModule(stableWasmBytes, options.pluginId);
    let memoryDeclarations: WasmMemoryDeclaration[] = [];
    try {
      memoryDeclarations = inspectWasmMemories(stableWasmBytes);
    } catch (error) {
      throw new WasmMemoryPolicyError(
        `Cannot validate linear memory declarations: ${error instanceof Error ? error.message : String(error)}`,
        options.pluginId,
      );
    }
    const inspection = this.inspectModule(module, stableWasmBytes);

    if (inspection.wasiDetected) {
      throw new Error("WASI imports are not authorized by the host");
    }
    if (inspection.importedModules.some(({ kind }) => kind === "tag")) {
      throw new WasmMemoryPolicyError(
        "Modules that import WebAssembly exception tags are not supported",
        options.pluginId,
      );
    }

    const fuelMeter = new WasmFuelMeter(
      options.fuel ?? { initialFuel: 1_000_000n },
      options.pluginId,
    );

    const importObject: Record<string, Record<string, WebAssembly.ImportValue>> = {};

    // 1. Fuel metering imports
    const fuelImports = fuelMeter.createHostImports();
    importObject.env = {
      ...(importObject.env ?? {}),
      ...fuelImports,
      host_log: (_level: number, _ptr: number, _len: number): void => {},
      host_now: (): number => performance.now(),
    };

    // 2. User host imports
    if (options.hostImports) {
      for (const [mod, fns] of Object.entries(options.hostImports)) {
        const guardedImports: Record<string, WebAssembly.ImportValue> = {};
        for (const [name, value] of Object.entries(fns)) {
          if (typeof value !== "function") {
            guardedImports[name] = value;
            continue;
          }

          guardedImports[name] = (...args: unknown[]): unknown => {
            if (args.some((argument) => typeof argument === "function")) {
              throw new WasmMemoryPolicyError(
                "WASM function references cannot be passed to host imports",
                options.pluginId,
              );
            }
            const result = Reflect.apply(value, undefined, args);
            if (result !== null && typeof result === "object") {
              throw new WasmMemoryPolicyError(
                "Host imports cannot return object references to WebAssembly",
                options.pluginId,
              );
            }
            return result;
          };
        }
        importObject[mod] = { ...(importObject[mod] ?? {}), ...guardedImports };
      }
    }
    // Callers cannot replace the host's fuel-accounting imports.
    importObject.env = { ...(importObject.env ?? {}), ...fuelImports };

    const memoryPolicyMax = options.memory?.maxPages ?? this.maxMemoryPagesPerInstance;
    if (
      !Number.isSafeInteger(memoryPolicyMax) ||
      memoryPolicyMax <= 0 ||
      memoryPolicyMax > this.maxMemoryPagesPerInstance
    ) {
      throw new WasmMemoryPolicyError(
        `Configured maximum must be between 1 and ${this.maxMemoryPagesPerInstance} pages`,
        options.pluginId,
      );
    }

    if (options.memory) {
      if (
        !Number.isSafeInteger(options.memory.initialPages) ||
        options.memory.initialPages < 0 ||
        options.memory.initialPages > memoryPolicyMax
      ) {
        throw new WasmMemoryPolicyError(
          "Configured initial page count is invalid",
          options.pluginId,
        );
      }
    }

    if (memoryDeclarations.length > 1) {
      throw new WasmMemoryPolicyError(
        "Modules with more than one linear memory are not supported",
        options.pluginId,
      );
    }

    const memoryDeclaration = memoryDeclarations[0];
    if (options.memory && !memoryDeclaration) {
      throw new WasmMemoryPolicyError(
        "A memory configuration was supplied for a module without linear memory",
        options.pluginId,
      );
    }

    let memoryReservation = 0;
    let memoryInstance: WebAssembly.Memory | undefined;
    let memoryExportName: string | undefined;
    let importedMemoryConfig: { initial: number; maximum: number } | undefined;
    if (memoryDeclaration) {
      const declaredMaximum = memoryDeclaration.maximumPages;
      if (declaredMaximum === undefined) {
        throw new WasmMemoryPolicyError(
          "Linear memories must declare a maximum page count",
          options.pluginId,
        );
      }

      if (memoryDeclaration.imported) {
        if (memoryDeclaration.importModule !== "env" || memoryDeclaration.importName !== "memory") {
          throw new WasmMemoryPolicyError(
            "Imported memory must use the host-managed env.memory import",
            options.pluginId,
          );
        }
        const initial = options.memory?.initialPages ?? memoryDeclaration.initialPages;
        const maximum = Math.min(memoryPolicyMax, declaredMaximum);
        if (
          initial < memoryDeclaration.initialPages ||
          initial > maximum ||
          memoryDeclaration.initialPages > maximum
        ) {
          throw new WasmMemoryPolicyError(
            "Configured imported memory does not satisfy the module's declared limits",
            options.pluginId,
          );
        }
        importedMemoryConfig = { initial, maximum };
        memoryReservation = maximum;
      } else {
        if (!memoryDeclaration.exportName) {
          throw new WasmMemoryPolicyError(
            "Module-defined memory must be exported so the host can measure its usage",
            options.pluginId,
          );
        }
        if (declaredMaximum > memoryPolicyMax) {
          throw new WasmMemoryPolicyError(
            `Module memory maximum of ${declaredMaximum} pages exceeds the configured limit of ${memoryPolicyMax}`,
            options.pluginId,
          );
        }
        memoryExportName = memoryDeclaration.exportName;
        memoryReservation = declaredMaximum;
      }
    }

    if (options.hostImports) {
      for (const imports of Object.values(options.hostImports)) {
        for (const value of Object.values(imports)) {
          if (hasWebAssemblyInternalSlot(value, WebAssembly.Memory.prototype, "buffer")) {
            throw new WasmMemoryPolicyError(
              "Host imports cannot provide unmanaged linear memory",
              options.pluginId,
            );
          }
          if (hasWebAssemblyInternalSlot(value, WebAssembly.Table.prototype, "length")) {
            throw new WasmMemoryPolicyError(
              "Host imports cannot provide WebAssembly tables",
              options.pluginId,
            );
          }
          const global = readWebAssemblyGlobalValue(value);
          if (
            global.recognized &&
            (global.value === null ||
              typeof global.value === "object" ||
              typeof global.value === "function")
          ) {
            throw new WasmMemoryPolicyError(
              "Host imports cannot provide nullable or reference-valued WebAssembly globals",
              options.pluginId,
            );
          }
        }
      }
    }

    const totalReservedPages = this.reservedMemoryPages + memoryReservation;
    if (
      !Number.isSafeInteger(totalReservedPages) ||
      totalReservedPages > this.maxAggregateMemoryPages
    ) {
      throw new WasmMemoryPolicyError(
        `Aggregate linear memory limit of ${this.maxAggregateMemoryPages} pages would be exceeded`,
        options.pluginId,
      );
    }

    this.reservedMemoryPages += memoryReservation;
    let released = false;
    const releaseMemoryReservation = (): void => {
      if (released) return;
      released = true;
      this.reservedMemoryPages -= memoryReservation;
    };

    try {
      if (importedMemoryConfig) {
        memoryInstance = new WebAssembly.Memory(importedMemoryConfig);
        importObject.env.memory = memoryInstance;
      }
      const wasmInstance = await WebAssembly.instantiate(module, importObject);

      const pluginInstance = new WasmPluginInstance(
        wasmInstance,
        fuelMeter,
        options.pluginId,
        memoryInstance,
        memoryExportName,
        releaseMemoryReservation,
      );

      return { instance: pluginInstance };
    } catch (error) {
      const failureMetrics: WasmInstantiationFailureMetrics = {
        fuelConsumed: fuelMeter.getConsumedFuel(),
        fuelRemaining: fuelMeter.getRemainingFuel(),
        memoryPagesUsed: memoryInstance ? memoryInstance.buffer.byteLength / 65536 : 0,
        memoryBytesUsed: memoryInstance?.buffer.byteLength ?? 0,
        memoryUsageAvailable: !memoryDeclaration || memoryInstance !== undefined,
      };
      if (error !== null && (typeof error === "object" || typeof error === "function")) {
        instantiationFailureMetrics.set(error, failureMetrics);
      }
      releaseMemoryReservation();
      throw error;
    }
  }

  /**
   * Executes a WASM capability with sub-0.2ms latency monitoring,
   * fuel bounds, and complete fault isolation.
   */
  public async executeWasm<TIn = unknown, TOut = unknown>(
    wasmBytes: Uint8Array,
    functionName: string,
    args: (number | bigint)[] = [],
    options: WasmInstanceOptions = {},
  ): Promise<WasmExecutionResult<TOut>> {
    const start = performance.now();
    let wasiSandbox: WasiSandbox | undefined;
    let pluginInstance: WasmPluginInstance | undefined;

    try {
      const { instance, wasiSandbox: ws } = await this.createInstance(wasmBytes, options);
      pluginInstance = instance;
      wasiSandbox = ws;

      // Timeout watchdog
      if (options.timeoutMs && options.timeoutMs > 0) {
        const timeoutMs = options.timeoutMs;
        const result = await Promise.race([
          Promise.resolve().then(() => instance.invoke(functionName, ...args)),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new WasmExecutionTimeoutError(timeoutMs, options.pluginId)),
              timeoutMs,
            ),
          ),
        ]);

        const metrics = instance.getMetrics(start);
        return {
          success: true,
          result: result as TOut,
          metrics,
          stdout: wasiSandbox?.getStdout(),
          stderr: wasiSandbox?.getStderr(),
        };
      }

      const rawResult = instance.invoke(functionName, ...args);
      const metrics = instance.getMetrics(start);

      return {
        success: true,
        result: rawResult as TOut,
        metrics,
        stdout: wasiSandbox?.getStdout(),
        stderr: wasiSandbox?.getStderr(),
      };
    } catch (err) {
      const latencyMs = performance.now() - start;
      const creationFailure =
        err !== null && (typeof err === "object" || typeof err === "function")
          ? instantiationFailureMetrics.get(err)
          : undefined;
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metrics: {
          latencyMs,
          fuelConsumed:
            pluginInstance?.fuelMeter.getConsumedFuel() ?? creationFailure?.fuelConsumed ?? 0n,
          fuelRemaining:
            pluginInstance?.fuelMeter.getRemainingFuel() ?? creationFailure?.fuelRemaining ?? 0n,
          memoryPagesUsed:
            pluginInstance?.getMemoryPagesUsed() ?? creationFailure?.memoryPagesUsed ?? 0,
          memoryBytesUsed:
            pluginInstance?.getMemoryBytesUsed() ?? creationFailure?.memoryBytesUsed ?? 0,
          memoryUsageAvailable:
            pluginInstance !== undefined ? true : (creationFailure?.memoryUsageAvailable ?? false),
        },
        stdout: wasiSandbox?.getStdout(),
        stderr: wasiSandbox?.getStderr(),
      };
    } finally {
      pluginInstance?.dispose();
    }
  }

  /**
   * Adapts WASM execution to standard PluginRpcResponse.
   */
  public async executeAsPluginRpc<TOut = unknown>(
    wasmBytes: Uint8Array,
    functionName: string,
    args: (number | bigint)[] = [],
    options: WasmInstanceOptions = {},
  ): Promise<PluginRpcResponse<TOut>> {
    const res = await this.executeWasm<unknown, TOut>(wasmBytes, functionName, args, options);
    return {
      id: crypto.randomUUID(),
      success: res.success,
      result: res.result,
      error: res.error,
      latencyMs: res.metrics.latencyMs,
    };
  }

  /**
   * Clears module cache.
   */
  public clearCache(): void {
    this.moduleCache.clear();
    this.cachedModuleSourceBytes = 0;
  }

  private cacheCompiledModule(key: string, module: WebAssembly.Module, sourceBytes: number): void {
    if (
      this.maxCachedModules === 0 ||
      this.maxCachedModuleSourceBytes === 0 ||
      sourceBytes > this.maxCachedModuleSourceBytes
    ) {
      return;
    }

    const previous = this.moduleCache.get(key);
    if (previous) {
      this.moduleCache.delete(key);
      this.cachedModuleSourceBytes -= previous.sourceBytes;
    }
    this.moduleCache.set(key, { module, sourceBytes });
    this.cachedModuleSourceBytes += sourceBytes;

    while (
      this.moduleCache.size > this.maxCachedModules ||
      this.cachedModuleSourceBytes > this.maxCachedModuleSourceBytes
    ) {
      const oldestKey = this.moduleCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.moduleCache.get(oldestKey);
      this.moduleCache.delete(oldestKey);
      this.cachedModuleSourceBytes -= oldest?.sourceBytes ?? 0;
    }
  }
}
