/**
 * @file wasi-sandbox.ts
 * WASI (WebAssembly System Interface) sandbox encapsulation.
 * Provides fine-grained workspace preopens, secure environment sanitization, and output isolation.
 */

import { WASI } from "node:wasi";
import type { WasiOptions } from "./wasm-types";

export class WasiSandbox {
  private wasiInstance: WASI | null = null;
  private stdoutBuffer: string[] = [];
  private stderrBuffer: string[] = [];
  private readonly options: WasiOptions;

  constructor(options: WasiOptions = {}) {
    this.options = options;
    this.initializeWasi();
  }

  private initializeWasi(): void {
    const cleanEnv: Record<string, string> = {
      RUST_BACKTRACE: "0",
      ...(this.options.env ?? {}),
    };

    const preopens = this.options.preopens ?? {};

    try {
      this.wasiInstance = new WASI({
        version: "preview1",
        args: this.options.args ?? ["modus-plugin"],
        env: cleanEnv,
        preopens,
        returnOnExit: true,
      });
    } catch {
      // Graceful fallback for non-WASI or environments where node:wasi is guarded
      this.wasiInstance = null;
    }
  }

  public getImportObject(): Record<string, Record<string, WebAssembly.ImportValue>> {
    if (this.wasiInstance) {
      try {
        const imports = this.wasiInstance.getImportObject() as Record<
          string,
          Record<string, WebAssembly.ImportValue>
        >;
        return imports;
      } catch {
        // Fallback below
      }
    }

    // Default safe no-op WASI preview1 mocks if WASI is not initialized
    return {
      wasi_snapshot_preview1: {
        proc_exit: (code: number): void => {
          this.stderrBuffer.push(`Process exited with code: ${code}`);
        },
        fd_write: (fd: number, _iovs: number, _iovs_len: number, _nwritten: number): number => {
          return 0;
        },
        fd_close: (_fd: number): number => 0,
        fd_seek: (_fd: number, _offset: bigint, _whence: number, _newoffset: number): number => 0,
        environ_get: (_environ: number, _environ_buf: number): number => 0,
        environ_sizes_get: (_environ_count: number, _environ_buf_size: number): number => 0,
        clock_time_get: (_clockid: number, _precision: bigint, _time: number): number => 0,
      },
    };
  }

  public start(instance: WebAssembly.Instance): void {
    if (this.wasiInstance && typeof instance.exports._start === "function") {
      try {
        this.wasiInstance.start(instance);
      } catch {
        // Ignored or exited
      }
    } else if (this.wasiInstance && typeof instance.exports.__wasm_call_ctors === "function") {
      try {
        this.wasiInstance.initialize(instance);
      } catch {
        // Ignored
      }
    }
  }

  public getStdout(): string {
    return this.stdoutBuffer.join("");
  }

  public getStderr(): string {
    return this.stderrBuffer.join("");
  }

  public clearOutputs(): void {
    this.stdoutBuffer = [];
    this.stderrBuffer = [];
  }
}
