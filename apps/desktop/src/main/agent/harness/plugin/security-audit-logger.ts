/**
 * @file security-audit-logger.ts
 * Cryptographically chained security audit log (Fase 13).
 * Each entry is hashed with SHA-256 linked to the preceding entry hash,
 * providing tamper-evident audit trails for all broker security decisions.
 */

import { createHash, randomUUID } from 'crypto';
import type { SecurityAuditEntry } from './plugin-isolation-types';

export const GENESIS_HASH = '0'.repeat(64);

export interface SecurityAuditFilter {
  pluginId?: string | undefined;
  decision?: 'allow' | 'deny' | undefined;
  action?: string | undefined;
  limit?: number | undefined;
}

export class SecurityAuditLogger {
  private static instance: SecurityAuditLogger | null = null;
  private entries: SecurityAuditEntry[] = [];
  private latestHash: string = GENESIS_HASH;

  constructor() {}

  public static getInstance(): SecurityAuditLogger {
    if (!SecurityAuditLogger.instance) {
      SecurityAuditLogger.instance = new SecurityAuditLogger();
    }
    return SecurityAuditLogger.instance;
  }

  public static resetInstance(): void {
    SecurityAuditLogger.instance = null;
  }

  public log(params: {
    pluginId: string;
    action: string;
    resource: string;
    decision: 'allow' | 'deny';
    reason?: string | undefined;
    timestamp?: number | undefined;
  }): SecurityAuditEntry {
    const timestamp = params.timestamp ?? Date.now();
    const id = randomUUID();
    const previousHash = this.latestHash;
    const reason = params.reason ?? '';

    const payload = `${previousHash}|${timestamp}|${params.pluginId}|${params.action}|${params.resource}|${params.decision}|${reason}`;
    const hash = createHash('sha256').update(payload).digest('hex');

    const entry: SecurityAuditEntry = {
      id,
      timestamp,
      pluginId: params.pluginId,
      action: params.action,
      resource: params.resource,
      decision: params.decision,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      hash,
      previousHash,
    };

    this.entries.push(entry);
    this.latestHash = hash;

    return entry;
  }

  public getEntries(filter?: SecurityAuditFilter): SecurityAuditEntry[] {
    let result = this.entries;

    if (filter?.pluginId) {
      result = result.filter((e) => e.pluginId === filter.pluginId);
    }
    if (filter?.decision) {
      result = result.filter((e) => e.decision === filter.decision);
    }
    if (filter?.action) {
      result = result.filter((e) => e.action === filter.action);
    }
    if (filter?.limit && filter.limit > 0) {
      result = result.slice(-filter.limit);
    }

    return [...result];
  }

  /**
   * Verifies the cryptographic integrity of the entire audit chain.
   */
  public verifyChain(): { valid: boolean; brokenAtIndex?: number; reason?: string } {
    let prev = GENESIS_HASH;

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;

      if (entry.previousHash !== prev) {
        return {
          valid: false,
          brokenAtIndex: i,
          reason: `Chain broken at index ${i}: previousHash "${entry.previousHash}" does not match preceding hash "${prev}"`,
        };
      }

      const payload = `${entry.previousHash}|${entry.timestamp}|${entry.pluginId}|${entry.action}|${entry.resource}|${entry.decision}|${entry.reason ?? ''}`;
      const expectedHash = createHash('sha256').update(payload).digest('hex');

      if (entry.hash !== expectedHash) {
        return {
          valid: false,
          brokenAtIndex: i,
          reason: `Tampering detected at index ${i}: stored hash "${entry.hash}" does not match recomputed hash "${expectedHash}"`,
        };
      }

      prev = entry.hash;
    }

    return { valid: true };
  }

  public clear(): void {
    this.entries = [];
    this.latestHash = GENESIS_HASH;
  }
}
