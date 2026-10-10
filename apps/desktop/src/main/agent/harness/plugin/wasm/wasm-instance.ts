/**
 * @file wasm-instance.ts
 * Manages an instantiated WebAssembly module, its linear memory, fuel meter, and typed calls.
 */

import type { WasmFuelMeter } from "./wasm-fuel-meter";
import { type WasmExecutionMetrics, WasmMemoryOutOfBoundsError } from "./wasm-types";

type EscapedWasmFunction = (...args: unknown[]) => unknown;

type EscapedFunctionReference = {
  target: EscapedWasmFunction | null;
  wrapper: (...args: unknown[]) => unknown;
};

export class WasmPluginInstance {
  #wasmInstance: WebAssembly.Instance | null;
  public readonly fuelMeter: WasmFuelMeter;
  public readonly pluginId?: string | undefined;
  #memory: WebAssembly.Memory | null;
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder();
  #disposed = false;
  #activeCalls = 0;
  #resourcesReleased = false;
  #releaseMemoryReservation: (() => void) | null;
  #escapedFunctionReferences = new Map<EscapedWasmFunction, EscapedFunctionReference>();

  constructor(
    instance: WebAssembly.Instance,
    fuelMeter: WasmFuelMeter,
    pluginId?: string,
    importedMemory?: WebAssembly.Memory,
    memoryExportName?: string,
    releaseMemoryReservation: () => void = () => {},
  ) {
    this.#wasmInstance = instance;
    this.fuelMeter = fuelMeter;
    this.#releaseMemoryReservation = releaseMemoryReservation;
    if (pluginId) {
      this.pluginId = pluginId;
    }

    if (importedMemory) {
      this.#memory = importedMemory;
    } else if (
      memoryExportName &&
      instance.exports[memoryExportName] instanceof WebAssembly.Memory
    ) {
      this.#memory = instance.exports[memoryExportName] as WebAssembly.Memory;
    } else {
      this.#memory = null;
    }
  }

  public getMemoryBytesUsed(): number {
    return this.#memory?.buffer.byteLength ?? 0;
  }

  public getMemoryPagesUsed(): number {
    return this.#memory ? this.#memory.buffer.byteLength / 65536 : 0;
  }

  public growMemory(additionalPages: number): number {
    this.assertActive();
    if (!this.#memory) {
      throw new Error("No linear memory available for this WASM instance");
    }
    if (!Number.isSafeInteger(additionalPages) || additionalPages < 0) {
      throw new RangeError("Memory growth must be a non-negative safe integer");
    }
    return this.#memory.grow(additionalPages);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#activeCalls === 0) this.releaseResources();
  }

  private releaseResources(): void {
    if (this.#resourcesReleased) return;
    this.#resourcesReleased = true;
    this.#wasmInstance = null;
    this.#memory = null;
    for (const reference of this.#escapedFunctionReferences.values()) {
      reference.target = null;
    }
    this.#escapedFunctionReferences.clear();
    const releaseMemoryReservation = this.#releaseMemoryReservation;
    this.#releaseMemoryReservation = null;
    releaseMemoryReservation?.();
  }

  private assertActive(): void {
    if (this.#disposed) {
      throw new Error("WASM plugin instance has been disposed");
    }
  }

  public invoke(functionName: string, ...args: (number | bigint)[]): unknown {
    this.assertActive();
    const fn = this.#wasmInstance?.exports[functionName];
    if (typeof fn !== "function") {
      throw new Error(
        `Function "${functionName}" is not exported by WASM module${
          this.pluginId ? ` in plugin "${this.pluginId}"` : ""
        }`,
      );
    }

    return this.invokeExport(fn as EscapedWasmFunction, args);
  }

  private invokeExport(fn: EscapedWasmFunction, args: unknown[]): unknown {
    this.assertActive();
    this.fuelMeter.consume(10n);
    this.#activeCalls += 1;

    try {
      const result = Reflect.apply(fn, undefined, args);
      this.assertActive();
      return this.guardReturnedFunctionReferences(result);
    } finally {
      this.#activeCalls -= 1;
      if (this.#disposed && this.#activeCalls === 0) this.releaseResources();
    }
  }

  private guardReturnedFunctionReferences(result: unknown): unknown {
    if (Array.isArray(result)) {
      return result.map((value) => this.guardReturnedFunctionReferences(value));
    }

    if (typeof result === "function") {
      const wasmFunction = result as EscapedWasmFunction;
      const cached = this.#escapedFunctionReferences.get(wasmFunction);
      if (cached) return cached.wrapper;

      const reference: EscapedFunctionReference = {
        target: wasmFunction,
        wrapper: (...args: unknown[]): unknown => {
          this.assertActive();
          const target = reference.target;
          if (!target) throw new Error("WASM plugin instance has been disposed");
          return this.invokeExport(target, args);
        },
      };
      this.#escapedFunctionReferences.set(wasmFunction, reference);
      return reference.wrapper;
    }

    if (result !== null && typeof result === "object") {
      throw new Error("WASM object references cannot be returned to the host");
    }

    return result;
  }

  public writeBytes(offset: number, bytes: Uint8Array): void {
    this.assertActive();
    if (!this.#memory) {
      throw new Error("No linear memory available for this WASM instance");
    }
    const totalBytes = this.#memory.buffer.byteLength;
    if (offset + bytes.length > totalBytes) {
      throw new WasmMemoryOutOfBoundsError(offset + bytes.length, totalBytes, this.pluginId);
    }
    const memView = new Uint8Array(this.#memory.buffer);
    memView.set(bytes, offset);
  }

  public readBytes(offset: number, length: number): Uint8Array {
    this.assertActive();
    if (!this.#memory) {
      throw new Error("No linear memory available for this WASM instance");
    }
    const totalBytes = this.#memory.buffer.byteLength;
    if (offset + length > totalBytes) {
      throw new WasmMemoryOutOfBoundsError(offset + length, totalBytes, this.pluginId);
    }
    return new Uint8Array(this.#memory.buffer.slice(offset, offset + length));
  }

  public writeString(offset: number, text: string): number {
    const encoded = this.textEncoder.encode(text);
    this.writeBytes(offset, encoded);
    return encoded.length;
  }

  public readString(offset: number, length: number): string {
    const bytes = this.readBytes(offset, length);
    return this.textDecoder.decode(bytes);
  }

  public invokeJson<TIn = unknown, TOut = unknown>(functionName: string, input: TIn): TOut {
    this.assertActive();
    const instance = this.#wasmInstance;
    if (!instance) {
      throw new Error("WASM plugin instance has been disposed");
    }
    const hasJsonMemoryApi =
      typeof instance.exports.alloc === "function" &&
      typeof instance.exports.dealloc === "function";

    const jsonString = JSON.stringify(input);
    const bytes = this.textEncoder.encode(jsonString);

    if (hasJsonMemoryApi) {
      const inputPtr = Number(this.invoke("alloc", bytes.length));

      try {
        this.writeBytes(inputPtr, bytes);
        const packedRes = this.invoke(functionName, inputPtr, bytes.length);

        if (typeof packedRes === "bigint") {
          const resPtr = Number(packedRes >> 32n);
          const resLen = Number(packedRes & 0xffffffffn);
          const resultStr = this.readString(resPtr, resLen);
          this.invoke("dealloc", resPtr, resLen);
          return JSON.parse(resultStr) as TOut;
        } else if (typeof packedRes === "number") {
          // If 32-bit pointer, read 4 bytes length header prefix
          const lenBytes = this.readBytes(packedRes, 4);
          const resLen = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0, true);
          const resultStr = this.readString(packedRes + 4, resLen);
          this.invoke("dealloc", packedRes, resLen + 4);
          return JSON.parse(resultStr) as TOut;
        }
      } finally {
        if (!this.#disposed) this.invoke("dealloc", inputPtr, bytes.length);
      }
    }

    // Direct invocation fallback if function accepts primitive or no memory
    const directRes = this.invoke(functionName, 0, 0);
    return directRes as TOut;
  }

  public getMetrics(startTime: number): WasmExecutionMetrics {
    this.assertActive();
    return {
      latencyMs: performance.now() - startTime,
      fuelConsumed: this.fuelMeter.getConsumedFuel(),
      fuelRemaining: this.fuelMeter.getRemainingFuel(),
      memoryPagesUsed: this.getMemoryPagesUsed(),
      memoryBytesUsed: this.getMemoryBytesUsed(),
      memoryUsageAvailable: true,
    };
  }
}
