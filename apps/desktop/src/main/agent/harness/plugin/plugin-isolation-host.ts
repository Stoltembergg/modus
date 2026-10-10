/**
 * @file plugin-isolation-host.ts
 * Plugin isolation boundary adapter (Fase 13 & Fase 19).
 * Untrusted execution stays disabled until a preemptible OS-backed sandbox is available.
 */

import { randomUUID } from "node:crypto";
import type { PluginRpcRequest, PluginRpcResponse } from "./plugin-isolation-types";
import { SecurityAuditLogger } from "./security-audit-logger";

export interface PluginIsolationOptions {
  auditLogger?: SecurityAuditLogger;
}

const ISOLATION_UNAVAILABLE =
  "OS-backed plugin isolation is unavailable; untrusted execution was blocked.";

export class PluginIsolationHost {
  private audit: SecurityAuditLogger;

  constructor(options: PluginIsolationOptions = {}) {
    this.audit = options.auditLogger ?? SecurityAuditLogger.getInstance();
  }

  public getAuditLogger(): SecurityAuditLogger {
    return this.audit;
  }

  /**
   * This facade deliberately does not execute JavaScript. Trust labels and permission
   * declarations are data, not proof that a callback is host-owned or isolated.
   */
  public async executeIsolated<TContext = unknown, TResult = unknown>(params: {
    pluginId: string;
    capability: string;
    context: TContext;
    implementation: (
      ctx: TContext,
      brokers: {
        fs: unknown;
        net: unknown;
        shell: unknown;
        git: unknown;
      },
    ) => Promise<TResult> | TResult;
  }): Promise<PluginRpcResponse<TResult>> {
    return this.blocked(
      params.pluginId,
      `capability.execute.${params.capability}`,
      params.capability,
    );
  }

  /**
   * Rejects WebAssembly execution through this facade until instantiation and execution
   * can occur in a preemptible operating-system sandbox.
   */
  public async executeWasm<TOut = unknown>(params: {
    pluginId: string;
    wasmBytes: Uint8Array;
    functionName: string;
  }): Promise<PluginRpcResponse<TOut>> {
    return this.blocked(
      params.pluginId,
      `wasm.execute.${params.functionName}`,
      params.functionName,
    );
  }

  private blocked<TResult>(
    pluginId: string,
    action: string,
    resource: string,
  ): PluginRpcResponse<TResult> {
    const error = ISOLATION_UNAVAILABLE;
    const startTime = Date.now();
    this.audit.log({ pluginId, action, resource, decision: "deny", reason: error });
    return { id: randomUUID(), success: false, error, latencyMs: Date.now() - startTime };
  }

  /**
   * Handles an RPC request envelope.
   */
  public async handleRpcRequest<TContext = unknown, TResult = unknown>(
    request: PluginRpcRequest,
    handler: (
      ctx: TContext,
      brokers: {
        fs: unknown;
        net: unknown;
        shell: unknown;
        git: unknown;
      },
    ) => Promise<TResult> | TResult,
  ): Promise<PluginRpcResponse<TResult>> {
    return this.executeIsolated<TContext, TResult>({
      pluginId: request.pluginId,
      capability: request.capability,
      context: request.payload as TContext,
      implementation: handler,
    });
  }
}
