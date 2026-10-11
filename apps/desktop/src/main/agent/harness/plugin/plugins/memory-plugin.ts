/**
 * Modus Internal Plugin — @modus/memory (Fase 10A Piloto 1)
 * Stateful capability providing persistent storage, retrieval, and compaction of project memories.
 */

import {
  type CapabilityImplementation,
  CapabilityUnavailableError,
} from "../../capability/capability-types";
import type { PluginManifest } from "../plugin-types";

export interface MemoryRecord {
  id: string;
  category: string;
  content: string;
  tags?: string[] | undefined;
  timestamp: number;
}

export class MemoryStore {
  private records = new Map<string, MemoryRecord>();

  public store(record: Omit<MemoryRecord, "timestamp">): MemoryRecord {
    const fullRecord: MemoryRecord = {
      ...record,
      timestamp: Date.now(),
    };
    this.records.set(record.id, fullRecord);
    return fullRecord;
  }

  public retrieve(query: string, tag?: string): MemoryRecord[] {
    const queryLower = query.toLowerCase();
    const results: MemoryRecord[] = [];
    for (const record of this.records.values()) {
      if (tag && (!record.tags || !record.tags.includes(tag))) {
        continue;
      }
      if (
        record.content.toLowerCase().includes(queryLower) ||
        record.category.toLowerCase().includes(queryLower)
      ) {
        results.push(record);
      }
    }
    return results;
  }

  public getAll(): MemoryRecord[] {
    return Array.from(this.records.values());
  }

  public compact(maxRetain: number = 100): number {
    if (this.records.size <= maxRetain) return 0;
    const sorted = Array.from(this.records.values()).sort((a, b) => a.timestamp - b.timestamp);
    const toRemove = sorted.slice(0, sorted.length - maxRetain);
    for (const r of toRemove) {
      this.records.delete(r.id);
    }
    return toRemove.length;
  }

  public clear(): void {
    this.records.clear();
  }
}

// Plugin shared instance
export const memoryStore = new MemoryStore();

const memoryRetrieveImpl: CapabilityImplementation<
  { query: string; tag?: string },
  MemoryRecord[]
> = {
  execute: () => {
    throw new CapabilityUnavailableError(
      "memory.retrieve",
      "the in-memory sample store is not the persisted project-memory service",
    );
  },
};

const memoryStoreImpl: CapabilityImplementation<
  { id: string; category: string; content: string; tags?: string[] },
  MemoryRecord
> = {
  execute: () => {
    throw new CapabilityUnavailableError(
      "memory.store",
      "the in-memory sample store is not the persisted project-memory service",
    );
  },
};

const memoryCompactImpl: CapabilityImplementation<
  { maxRetain?: number },
  { prunedCount: number; remainingCount: number }
> = {
  execute: () => {
    throw new CapabilityUnavailableError(
      "memory.compact",
      "the in-memory sample store is not the persisted project-memory service",
    );
  },
};

export const memoryPluginManifest: PluginManifest = {
  id: "@modus/memory",
  name: "Modus Memory Service",
  version: "1.0.0",
  author: "Modus Core Team",
  description:
    "Legacy in-memory sample; project-memory capabilities are unavailable here because this store is not durable",
  trustLevel: "core",

  provides: [
    {
      capability: "memory.retrieve",
      apiVersion: "1.0",
      implementation: memoryRetrieveImpl,
    },
    {
      capability: "memory.store",
      apiVersion: "1.0",
      implementation: memoryStoreImpl,
    },
    {
      capability: "memory.compact",
      apiVersion: "1.0",
      implementation: memoryCompactImpl,
    },
  ],

  requires: {
    modus: ">=0.8.0",
  },

  permissions: {
    required: {},
  },

  lifecycle: {
    onLoad: () => {
      // Initialize or warm up cache
    },
    onUnload: () => {
      memoryStore.clear();
    },
  },
};
