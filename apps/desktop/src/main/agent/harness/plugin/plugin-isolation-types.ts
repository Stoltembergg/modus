/**
 * @file plugin-isolation-types.ts
 * Core contracts for Fase 13 — Plugin Isolation, Permission Brokers, and Cryptographic Security Audit.
 * Extended in Fase 19 — High-Performance Sandboxing (WASM & Micro-VMs).
 */

import type { TrustLevel } from '../capability/capability-types';

export class PermissionDeniedError extends Error {
  constructor(
    public readonly action: string,
    public readonly resource: string,
    public readonly pluginId?: string,
    public readonly reason?: string,
  ) {
    const details = [
      `Action: "${action}"`,
      `Resource: "${resource}"`,
      pluginId ? `Plugin: "${pluginId}"` : null,
      reason ? `Reason: ${reason}` : null,
    ]
      .filter(Boolean)
      .join(', ');

    super(`Permission denied: ${details}`);
    this.name = 'PermissionDeniedError';
  }
}

export interface SecurityAuditEntry {
  id: string;
  timestamp: number;
  pluginId: string;
  action: string;
  resource: string;
  decision: 'allow' | 'deny';
  reason?: string | undefined;
  hash: string;
  previousHash: string;
}

export interface BrokerRequest {
  pluginId: string;
  trustLevel: TrustLevel;
  action: string;
  resource: string;
  operation?: string | undefined;
  content?: unknown | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ExtendedPluginPermissions {
  filesystem?: {
    read?: string[] | undefined;
    write?: string[] | undefined;
  } | undefined;
  network?: {
    domains?: string[] | undefined;
    ports?: number[] | undefined;
    allowLocalhost?: boolean | undefined;
  } | undefined;
  shell?: {
    allow?: string[] | undefined;
    deny?: string[] | undefined;
  } | undefined;
  git?: {
    allowPush?: boolean | undefined;
    allowClone?: boolean | undefined;
    allowFetch?: boolean | undefined;
  } | undefined;
  memory?: {
    read?: boolean | undefined;
    write?: boolean | undefined;
  } | undefined;
  env?: {
    allow?: string[] | undefined;
    deny?: string[] | undefined;
  } | undefined;
  resources?: {
    maxMemoryMb?: number | undefined;
    timeoutMs?: number | undefined;
  } | undefined;
  wasm?: {
    maxFuel?: bigint | undefined;
    maxMemoryMb?: number | undefined;
    allowWasi?: boolean | undefined;
  } | undefined;
}

export type IsolationMode = 'direct' | 'sandboxed' | 'wasm';

export interface PluginRpcRequest {
  id: string;
  pluginId: string;
  capability: string;
  payload: unknown;
  timeoutMs?: number | undefined;
}

export interface PluginRpcResponse<T = unknown> {
  id: string;
  success: boolean;
  result?: T | undefined;
  error?: string | undefined;
  latencyMs: number;
}
