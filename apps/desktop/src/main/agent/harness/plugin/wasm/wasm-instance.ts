/**
 * @file wasm-instance.ts
 * Manages an instantiated WebAssembly module, its linear memory, fuel meter, and typed calls.
 */

import {
  WasmMemoryOutOfBoundsError,
  type WasmExecutionMetrics,
} from './wasm-types';
import type { WasmFuelMeter } from './wasm-fuel-meter';

export class WasmPluginInstance {
  public readonly instance: WebAssembly.Instance;
  public readonly fuelMeter: WasmFuelMeter;
  public readonly pluginId?: string | undefined;
  private readonly memory: WebAssembly.Memory | null;
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder();

  constructor(
    instance: WebAssembly.Instance,
    fuelMeter: WasmFuelMeter,
    pluginId?: string,
    importedMemory?: WebAssembly.Memory,
  ) {
    this.instance = instance;
    this.fuelMeter = fuelMeter;
    if (pluginId) {
      this.pluginId = pluginId;
    }

    if (importedMemory) {
      this.memory = importedMemory;
    } else if (instance.exports.memory instanceof WebAssembly.Memory) {
      this.memory = instance.exports.memory;
    } else {
      this.memory = null;
    }
  }

  public getMemory(): WebAssembly.Memory | null {
    return this.memory;
  }

  public getMemoryBytesUsed(): number {
    return this.memory ? this.memory.buffer.byteLength : 0;
  }

  public getMemoryPagesUsed(): number {
    return this.memory ? this.memory.buffer.byteLength / 65536 : 0;
  }

  public invoke(functionName: string, ...args: (number | bigint)[]): unknown {
    const fn = this.instance.exports[functionName];
    if (typeof fn !== 'function') {
      throw new Error(
        `Function "${functionName}" is not exported by WASM module${
          this.pluginId ? ` in plugin "${this.pluginId}"` : ''
        }`,
      );
    }

    // Deduct standard invocation fuel cost
    this.fuelMeter.consume(10n);

    return fn(...args);
  }

  public writeBytes(offset: number, bytes: Uint8Array): void {
    if (!this.memory) {
      throw new Error('No linear memory available for this WASM instance');
    }
    const totalBytes = this.memory.buffer.byteLength;
    if (offset + bytes.length > totalBytes) {
      throw new WasmMemoryOutOfBoundsError(
        offset + bytes.length,
        totalBytes,
        this.pluginId,
      );
    }
    const memView = new Uint8Array(this.memory.buffer);
    memView.set(bytes, offset);
  }

  public readBytes(offset: number, length: number): Uint8Array {
    if (!this.memory) {
      throw new Error('No linear memory available for this WASM instance');
    }
    const totalBytes = this.memory.buffer.byteLength;
    if (offset + length > totalBytes) {
      throw new WasmMemoryOutOfBoundsError(
        offset + length,
        totalBytes,
        this.pluginId,
      );
    }
    return new Uint8Array(this.memory.buffer.slice(offset, offset + length));
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

  public invokeJson<TIn = unknown, TOut = unknown>(
    functionName: string,
    input: TIn,
  ): TOut {
    const allocFn = this.instance.exports.alloc;
    const deallocFn = this.instance.exports.dealloc;

    const jsonString = JSON.stringify(input);
    const bytes = this.textEncoder.encode(jsonString);

    if (typeof allocFn === 'function' && typeof deallocFn === 'function') {
      const inputPtr = Number(allocFn(bytes.length));
      this.writeBytes(inputPtr, bytes);

      try {
        const packedRes = this.invoke(functionName, inputPtr, bytes.length);

        if (typeof packedRes === 'bigint') {
          const resPtr = Number(packedRes >> 32n);
          const resLen = Number(packedRes & 0xffffffffn);
          const resultStr = this.readString(resPtr, resLen);
          deallocFn(resPtr, resLen);
          return JSON.parse(resultStr) as TOut;
        } else if (typeof packedRes === 'number') {
          // If 32-bit pointer, read 4 bytes length header prefix
          const lenBytes = this.readBytes(packedRes, 4);
          const resLen = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0, true);
          const resultStr = this.readString(packedRes + 4, resLen);
          deallocFn(packedRes, resLen + 4);
          return JSON.parse(resultStr) as TOut;
        }
      } finally {
        deallocFn(inputPtr, bytes.length);
      }
    }

    // Direct invocation fallback if function accepts primitive or no memory
    const directRes = this.invoke(functionName, 0, 0);
    return directRes as TOut;
  }

  public getMetrics(startTime: number): WasmExecutionMetrics {
    return {
      latencyMs: performance.now() - startTime,
      fuelConsumed: this.fuelMeter.getConsumedFuel(),
      fuelRemaining: this.fuelMeter.getRemainingFuel(),
      memoryPagesUsed: this.getMemoryPagesUsed(),
      memoryBytesUsed: this.getMemoryBytesUsed(),
    };
  }
}
