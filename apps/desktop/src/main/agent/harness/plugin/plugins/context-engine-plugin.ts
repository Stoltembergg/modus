/**
 * Modus Internal Plugin — @modus/context-engine (Fase 10B)
 * Core capability managing context window assembly, selective filtering, and project context.
 */

import type { CapabilityImplementation } from "../../capability/capability-types";
import type { PluginManifest } from "../plugin-types";

export interface ContextItem {
  key: string;
  source: string;
  content: string;
  tokenCount: number;
  priority: number;
}

const contextResolveImpl: CapabilityImplementation<
  { query: string; tokenBudget?: number },
  { items: ContextItem[]; totalTokens: number }
> = {
  execute: (ctx) => {
    const defaultBudget = ctx.tokenBudget ?? 8000;
    const items: ContextItem[] = [
      {
        key: "project-summary",
        source: "workspace",
        content: `Resolved context for: ${ctx.query}`,
        tokenCount: 150,
        priority: 1,
      },
    ];
    return {
      items,
      totalTokens: 150,
    };
  },
};

const contextFilterImpl: CapabilityImplementation<
  { items: ContextItem[]; maxTokens: number },
  { filtered: ContextItem[]; droppedCount: number }
> = {
  execute: (ctx) => {
    let accumulated = 0;
    const filtered: ContextItem[] = [];
    let dropped = 0;

    const sorted = [...ctx.items].sort((a, b) => b.priority - a.priority);
    for (const item of sorted) {
      if (accumulated + item.tokenCount <= ctx.maxTokens) {
        filtered.push(item);
        accumulated += item.tokenCount;
      } else {
        dropped++;
      }
    }
    return { filtered, droppedCount: dropped };
  },
};

export const contextEnginePluginManifest: PluginManifest = {
  id: "@modus/context-engine",
  name: "Modus Context Engine",
  version: "1.0.0",
  author: "Modus Core Team",
  description: "Core capability for selective context building and token budgeting",
  trustLevel: "core",

  provides: [
    {
      capability: "context.resolve",
      apiVersion: "1.0",
      implementation: contextResolveImpl,
    },
    {
      capability: "context.filter",
      apiVersion: "1.0",
      implementation: contextFilterImpl,
    },
  ],

  requires: {
    modus: ">=0.8.0",
    capabilities: [
      {
        capability: "memory.retrieve",
        version: "^1.0",
      },
    ],
  },

  permissions: {
    required: {
      memory: { read: true },
    },
    reason: {
      memory: "Read project memory digests for contextual planning",
    },
  },
};
