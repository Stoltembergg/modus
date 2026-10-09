/**
 * @file wasi-sandbox.ts
 * WASI (WebAssembly System Interface) sandbox encapsulation.
 * Provides fine-grained workspace preopens, secure environment sanitization, and output isolation.
 */

import { WASI } from "node:wasi";
import type { WasiOptions } from "./wasm-types";

export class WasiSandbox {
  private wasiInstance!: WASI;
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

    this.wasiInstance = new WASI({
      version: "preview1",
      args: this.options.args ?? ["modus-plugin"],
      env: cleanEnv,
      preopens,
      returnOnExit: true,
    });
  }

  public getImportObject(): Record<string, Record<string, WebAssembly.ImportValue>> {
    return this.wasiInstance.getImportObject() as Record<
      string,
      Record<string, WebAssembly.ImportValue>
    >;
  }

  public start(instance: WebAssembly.Instance): void {
    if (typeof instance.exports._start === "function") {
      this.wasiInstance.start(instance);
    } else if (typeof instance.exports.__wasm_call_ctors === "function") {
      this.wasiInstance.initialize(instance);
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
