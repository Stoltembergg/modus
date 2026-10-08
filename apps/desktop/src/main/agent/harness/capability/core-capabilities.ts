/**
 * @file core-capabilities.ts
 * Registration of standard Modus core capabilities and default providers.
 */

import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from "./capability-registration-authority";
import type { CapabilityRegistry } from "./capability-registry";
import type { Capability, CapabilityImplementation, CapabilityProvider } from "./capability-types";

export const CORE_CAPABILITIES: Capability[] = [
  // Memory capabilities
  {
    id: "memory.retrieve",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Retrieve project memories relevant to context",
      stability: "stable",
      tags: ["memory", "planning"],
    },
  },
  {
    id: "memory.store",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Persist learnings and decisions into project memory",
      stability: "stable",
      tags: ["memory", "persistence"],
    },
  },
  {
    id: "memory.search",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Semantic and lexical search over accumulated memory",
      stability: "stable",
      tags: ["memory", "search"],
    },
  },

  // Context Engine capabilities
  {
    id: "context.resolve",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Resolve and assemble prompt context components",
      stability: "stable",
      tags: ["context", "prompt"],
    },
  },
  {
    id: "context.compact",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Intelligently prune and compact context tokens",
      stability: "stable",
      tags: ["context", "compaction"],
    },
  },
  {
    id: "context.summarize",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Generate semantic summaries of historical turns",
      stability: "stable",
      tags: ["context", "summary"],
    },
  },

  // Agent Loop capabilities
  {
    id: "agent.loop",
    apiVersion: "1.0",
    replaceable: false, // Core runtime invariant
    dependencies: [],
    metadata: {
      description: "Core turn lifecycle loop and prompt dispatch",
      stability: "stable",
      tags: ["agent", "core"],
    },
  },
  {
    id: "agent.pause",
    apiVersion: "1.0",
    replaceable: false,
    dependencies: [],
    metadata: {
      description: "Pause active turn or step execution",
      stability: "stable",
      tags: ["agent", "control"],
    },
  },
  {
    id: "agent.resume",
    apiVersion: "1.0",
    replaceable: false,
    dependencies: [],
    metadata: {
      description: "Resume paused turn or session",
      stability: "stable",
      tags: ["agent", "control"],
    },
  },

  // Model Selection capabilities
  {
    id: "model.select",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Select appropriate LLM model and parameters for task",
      stability: "stable",
      tags: ["model", "routing"],
    },
  },
  {
    id: "model.switch",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Dynamically switch model during multi-step escalation",
      stability: "stable",
      tags: ["model", "escalation"],
    },
  },

  // Tools execution capabilities
  {
    id: "tools.shell",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Execute shell commands with safety checks",
      stability: "stable",
      tags: ["tools", "shell"],
    },
  },
  {
    id: "tools.file",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Perform filesystem operations within workspace boundaries",
      stability: "stable",
      tags: ["tools", "filesystem"],
    },
  },
  {
    id: "tools.search",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Perform text/code search (grep, fd, ripgrep)",
      stability: "stable",
      tags: ["tools", "search"],
    },
  },

  // Verification & QA capabilities
  {
    id: "verification.run",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Execute verification check scripts and test suites",
      stability: "stable",
      tags: ["verification", "qa"],
    },
  },
  {
    id: "verification.analyze",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: ["verification.run@^1.0"],
    metadata: {
      description: "Analyze verification test output and extract structured QA evidence",
      stability: "stable",
      tags: ["verification", "analysis"],
    },
  },

  // Compaction Strategy capabilities
  {
    id: "compaction.strategy",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Determine pruning and compaction policy for active session",
      stability: "stable",
      tags: ["compaction", "policy"],
    },
  },

  // Groups & Collaboration capabilities
  {
    id: "group.route",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Route inter-agent messages within peer mailbox",
      stability: "stable",
      tags: ["groups", "routing"],
    },
  },
  {
    id: "group.select",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Select group hierarchy or subagent roles for task",
      stability: "stable",
      tags: ["groups", "selection"],
    },
  },

  // Failure Intelligence capabilities
  {
    id: "failure.analyze",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: [],
    metadata: {
      description: "Analyze turn errors and tool failures to update blacklist",
      stability: "stable",
      tags: ["failure", "intelligence"],
    },
  },
  {
    id: "failure.predict",
    apiVersion: "1.0",
    replaceable: true,
    dependencies: ["failure.analyze@^1.0"],
    metadata: {
      description: "Predict repetitive loop patterns and advise mitigation",
      stability: "stable",
      tags: ["failure", "prediction"],
    },
  },
];

/**
 * Creates default fallback implementations for core capabilities.
 */
function createDefaultImplementation(capabilityId: string): CapabilityImplementation {
  return {
    execute: async (context: unknown) => {
      return {
        status: "ok",
        capabilityId,
        handledBy: "@modus/core",
        timestamp: Date.now(),
        contextEcho: context,
      };
    },
  };
}

/**
 * Registers all core capabilities and binds default @modus/* core providers.
 */
export function registerCoreCapabilities(
  registry: CapabilityRegistry,
  customImplementations: Partial<Record<string, CapabilityImplementation>> = {},
): void {
  for (const capability of CORE_CAPABILITIES) {
    registry.registerCapability(capability);

    const providerId = `@modus/${capability.id.split(".")[0]}`;
    const implementation =
      customImplementations[capability.id] ?? createDefaultImplementation(capability.id);

    const provider: CapabilityProvider = {
      providerId,
      providerVersion: "1.0.0",
      capabilityId: capability.id,
      capabilityApiVersion: capability.apiVersion,
      trustLevel: "core",
      permissions: {
        filesystem: { read: ["*"], write: ["*"] },
        memory: { read: true, write: true },
      },
      implementation,
      registeredAt: new Date(),
      metadata: {
        author: "Modus Team",
        description: `Official core provider for ${capability.id}`,
      },
    };

    registry.registerProvider(provider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
    registry.activateProvider(capability.id, providerId);
  }
}
