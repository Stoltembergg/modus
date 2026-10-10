import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiSdkRuntime } from "../../pi-sdk-runtime";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import { CapabilityDiscovery } from "./capability-discovery";
import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from "./capability-registration-authority";
import { CapabilityRegistry, resetCapabilityRegistry } from "./capability-registry";
import type { Capability, CapabilityProvider } from "./capability-types";
import {
  CapabilityConflictError,
  CapabilityUnavailableError,
  IncompatibleApiVersionError,
  NoProviderError,
} from "./capability-types";
import { CORE_CAPABILITIES, registerCoreCapabilities } from "./core-capabilities";

describe("Fase 9 — Capability Registry & Provenance Architecture", () => {
  let registry: CapabilityRegistry;

  beforeEach(() => {
    resetCapabilityRegistry();
    registry = new CapabilityRegistry();
    resetFeatureFlagOverrides();
  });

  describe("9.1 — Capability Registration and Version Decoupling", () => {
    it("isolates registered capability and provider data from inputs and public snapshots", async () => {
      const cap: Capability = {
        id: "snapshot.cap",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: ["base.cap"],
        metadata: { description: "original", tags: ["safe"] },
      };
      registry.registerCapability(cap);
      const called = vi.fn(() => "original implementation");
      const implementation = { execute: called };
      const registeredAt = new Date("2025-01-01T00:00:00.000Z");
      const provider: CapabilityProvider = {
        providerId: "@host/provider",
        providerVersion: "1.0.0",
        capabilityId: cap.id,
        capabilityApiVersion: "1.0",
        trustLevel: "core",
        permissions: {
          filesystem: { read: ["/safe"] },
          network: { domains: ["example.test"], ports: [443] },
          tools: { allow: ["read"] },
        },
        implementation,
        registeredAt,
        metadata: { author: "host", performance: { avgLatency: 1 } },
      };
      registry.registerProvider(provider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      cap.dependencies[0] = "changed";
      cap.metadata.tags?.push("changed");
      provider.providerId = "@attacker/provider";
      provider.permissions.filesystem?.read?.push("/attacker");
      provider.permissions.network?.domains?.push("attacker.test");
      provider.metadata.performance!.avgLatency = 999;
      registeredAt.setFullYear(2030);
      implementation.execute = (() => "mutated implementation") as typeof implementation.execute;

      const capability = registry.getCapability("snapshot.cap")!;
      const capabilityList = registry.listCapabilities();
      const active = registry.getActiveProvider("snapshot.cap")!;
      const providers = registry.listProviders("snapshot.cap");
      for (const snapshot of [active, providers[0]!]) {
        expect(snapshot.implementation).not.toBe(implementation);
        expect(() => {
          snapshot.implementation.execute = () => "facade attack";
        }).toThrow();
      }
      for (const snapshot of [capability, capabilityList[0]!]) {
        expect(() => {
          snapshot.dependencies.push("mutated");
        }).toThrow();
        expect(() => {
          snapshot.metadata.tags?.push("mutated");
        }).toThrow();
      }
      for (const snapshot of [active, providers[0]!]) {
        expect(() => {
          snapshot.permissions.filesystem?.read?.push("/mutated");
        }).toThrow();
        expect(() => {
          snapshot.permissions.network?.domains?.push("mutated.test");
        }).toThrow();
        expect(() => {
          snapshot.metadata.performance!.avgLatency = 2000;
        }).toThrow();
      }
      active.registeredAt.setFullYear(2040);
      expect(() => {
        providers.splice(0, 1);
      }).toThrow();
      expect(() => {
        capabilityList.splice(0, 1);
      }).toThrow();

      expect(registry.getCapability("snapshot.cap")?.dependencies).toEqual(["base.cap"]);
      expect(registry.getCapability("snapshot.cap")?.metadata.tags).toEqual(["safe"]);
      expect(registry.getActiveProvider("snapshot.cap")?.providerId).toBe("@host/provider");
      expect(registry.getActiveProvider("snapshot.cap")?.permissions.filesystem?.read).toEqual([
        "/safe",
      ]);
      expect(registry.getActiveProvider("snapshot.cap")?.registeredAt.toISOString()).toBe(
        "2025-01-01T00:00:00.000Z",
      );
      expect(await registry.execute("snapshot.cap", {})).toBe("original implementation");
      expect(called).toHaveBeenCalledOnce();
    });

    it("passes the caller AbortSignal through the registered provider wrapper", async () => {
      const signalSeen = vi.fn();
      registry.registerCapability({
        id: "cancel.propagation",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: {},
      });
      registry.registerProvider(
        {
          providerId: "@host/cancel-probe",
          providerVersion: "1.0.0",
          capabilityId: "cancel.propagation",
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation: {
            execute: (_context, signal) => {
              signalSeen(signal);
              return "completed";
            },
          },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      const controller = new AbortController();
      await expect(registry.execute("cancel.propagation", {}, controller.signal)).resolves.toBe(
        "completed",
      );

      expect(signalSeen).toHaveBeenCalledOnce();
      expect(signalSeen).toHaveBeenCalledWith(controller.signal);
    });

    it.each([
      true,
      false,
    ])("keeps capability replaceability authoritative after input/getter mutation (replaceable=%s)", (replaceable) => {
      const cap: Capability = {
        id: "replace.guard",
        apiVersion: "1.0",
        replaceable,
        dependencies: [],
        metadata: {},
      };
      registry.registerCapability(cap);
      cap.replaceable = !replaceable;
      const provider: CapabilityProvider = {
        providerId: "@host/first",
        providerVersion: "1",
        capabilityId: cap.id,
        capabilityApiVersion: "1.0",
        trustLevel: "core",
        permissions: {},
        implementation: { execute: () => "first" },
        registeredAt: new Date(),
        metadata: {},
      };
      registry.registerProvider(provider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      expect(() => {
        registry.getCapability(cap.id)!.replaceable = !replaceable;
      }).toThrow();
      if (replaceable) {
        expect(() =>
          registry.registerProvider(
            { ...provider, providerId: "@host/second" },
            HOST_CAPABILITY_REGISTRATION_AUTHORITY,
          ),
        ).not.toThrow();
      } else {
        expect(() =>
          registry.registerProvider(
            { ...provider, providerId: "@host/second" },
            HOST_CAPABILITY_REGISTRATION_AUTHORITY,
          ),
        ).toThrow(CapabilityConflictError);
      }
    });

    it("registers and retrieves a capability specification", () => {
      const cap: Capability = {
        id: "memory.retrieve",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: {
          description: "Retrieve project memories",
          stability: "stable",
        },
      };

      registry.registerCapability(cap);
      const retrieved = registry.getCapability("memory.retrieve");

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe("memory.retrieve");
      expect(retrieved?.apiVersion).toBe("1.0");
      expect(retrieved?.replaceable).toBe(true);
    });

    it("rejects re-registration with conflicting API version", () => {
      registry.registerCapability({
        id: "memory.retrieve",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: { description: "v1", stability: "stable" },
      });

      expect(() => {
        registry.registerCapability({
          id: "memory.retrieve",
          apiVersion: "2.0",
          replaceable: true,
          dependencies: [],
          metadata: { description: "v2", stability: "stable" },
        });
      }).toThrow(CapabilityConflictError);
    });

    it("registers a provider matching the capability API version", () => {
      registry.registerCapability({
        id: "context.resolve",
        apiVersion: "1.2",
        replaceable: true,
        dependencies: [],
        metadata: { description: "Context resolver", stability: "stable" },
      });

      const provider: CapabilityProvider = {
        providerId: "@modus/context-engine",
        providerVersion: "2.4.0",
        capabilityId: "context.resolve",
        capabilityApiVersion: "1.2",
        trustLevel: "core",
        permissions: {},
        implementation: {
          execute: async () => ({ resolved: true }),
        },
        registeredAt: new Date(),
        metadata: {},
      };

      registry.registerProvider(provider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      expect(registry.getActiveProvider("context.resolve")?.providerId).toBe(
        "@modus/context-engine",
      );
    });

    it("rejects a provider with incompatible major API version", () => {
      registry.registerCapability({
        id: "context.resolve",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: { description: "Context resolver", stability: "stable" },
      });

      const incompatibleProvider: CapabilityProvider = {
        providerId: "@external/legacy-resolver",
        providerVersion: "0.9.0",
        capabilityId: "context.resolve",
        capabilityApiVersion: "2.0", // Incompatible major version
        trustLevel: "community",
        permissions: {},
        implementation: { execute: () => {} },
        registeredAt: new Date(),
        metadata: {},
      };

      expect(() => {
        registry.registerProvider(incompatibleProvider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      }).toThrow(IncompatibleApiVersionError);
    });
  });

  describe("9.2 — Multi-Provider Support and Provider Switching", () => {
    it("does not expose caller receivers and captures the registered arrow implementation", async () => {
      registry.registerCapability({
        id: "immutable.impl",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: {},
      });
      const methodSource = {
        value: "original",
        execute() {
          this.value = "poison";
          return this.value;
        },
      };
      let count = 0;
      const implementation = { execute: () => ++count };
      registry.registerProvider(
        {
          providerId: "@host/immutable",
          providerVersion: "1",
          capabilityId: "immutable.impl",
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation,
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      registry.registerCapability({
        id: "receiver.impl",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: {},
      });
      registry.registerProvider(
        {
          providerId: "@host/receiver",
          providerVersion: "1",
          capabilityId: "receiver.impl",
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation: methodSource,
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      methodSource.execute = () => "source replaced";
      implementation.execute = () => 99;
      const active = registry.getActiveProvider("immutable.impl")!;
      const listed = registry.listProviders("immutable.impl")[0]!;
      try {
        active.implementation.execute = () => "snapshot mutated";
      } catch {
        /* frozen facade */
      }
      try {
        listed.implementation.execute = () => "list mutated";
      } catch {
        /* frozen facade */
      }

      expect(await registry.execute("immutable.impl", {})).toBe(1);
      expect(await registry.execute("immutable.impl", {})).toBe(2);
      await expect(registry.execute("receiver.impl", {})).rejects.toThrow();
      expect(methodSource.value).toBe("original");
      expect(await registry.execute("immutable.impl", {})).toBe(3);
    });

    it("quarantines providers against dispatch, queries, and activation until host recovery", async () => {
      registry.registerCapability({
        id: "quarantine.cap",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: {},
      });
      registry.registerProvider(
        {
          providerId: "@plugin/quarantined",
          providerVersion: "1",
          capabilityId: "quarantine.cap",
          capabilityApiVersion: "1.0",
          trustLevel: "official",
          permissions: {},
          implementation: { execute: () => "blocked" },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );
      registry.registerProvider(
        {
          providerId: "@host/fallback",
          providerVersion: "1",
          capabilityId: "quarantine.cap",
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation: { execute: () => "fallback" },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      registry.quarantineProvider("@plugin/quarantined", HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      expect(registry.getActiveProvider("quarantine.cap")?.providerId).toBe("@host/fallback");
      expect(await registry.execute("quarantine.cap", {})).toBe("fallback");
      expect(() => registry.activateProvider("quarantine.cap", "@plugin/quarantined")).toThrow(
        CapabilityConflictError,
      );
      expect(() => registry.switchProvider("quarantine.cap", "@plugin/quarantined")).toThrow(
        CapabilityConflictError,
      );
      registry.clearProviderQuarantine(
        "@plugin/quarantined",
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );
      registry.activateProvider("quarantine.cap", "@plugin/quarantined");
      expect(await registry.execute("quarantine.cap", {})).toBe("blocked");
    });

    it("rejects caller-authorized trust and same-ID provider replacement for replaceable capabilities", () => {
      registry.registerCapability({
        id: "memory.retrieve",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: { description: "Memory retrieval" },
      });
      const original: CapabilityProvider = {
        providerId: "@modus/provider",
        providerVersion: "1.0.0",
        capabilityId: "memory.retrieve",
        capabilityApiVersion: "1.0",
        trustLevel: "core",
        permissions: {},
        implementation: { execute: () => "trusted" },
        registeredAt: new Date(),
        metadata: {},
      };
      registry.registerProvider(original, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      expect(() =>
        registry.registerProvider({
          ...original,
          trustLevel: "core",
          implementation: { execute: () => "attacker" },
        }),
      ).toThrow(CapabilityConflictError);
      expect(registry.getActiveProvider("memory.retrieve")?.implementation).not.toBe(
        original.implementation,
      );
      expect(registry.listProviders("memory.retrieve")).toHaveLength(1);
    });

    it("rejects unauthenticated same-ID attempts on non-replaceable capabilities", () => {
      registry.registerCapability({
        id: "agent.loop",
        apiVersion: "1.0",
        replaceable: false,
        dependencies: [],
        metadata: { description: "Core loop" },
      });
      const implementation = { execute: () => "core" };
      const original: CapabilityProvider = {
        providerId: "@modus/core-loop",
        providerVersion: "1.0.0",
        capabilityId: "agent.loop",
        capabilityApiVersion: "1.0",
        trustLevel: "core",
        permissions: {},
        implementation,
        registeredAt: new Date(),
        metadata: {},
      };
      registry.registerProvider(original, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      expect(() =>
        registry.registerProvider({
          ...original,
          trustLevel: "core",
          implementation: { execute: () => "hijacked" },
        }),
      ).toThrow(CapabilityConflictError);
      expect(registry.getActiveProvider("agent.loop")?.implementation).not.toBe(implementation);
      expect(registry.listProviders("agent.loop")).toHaveLength(1);
    });

    it("supports multiple providers for the same capability and allows switching", () => {
      registry.registerCapability({
        id: "memory.retrieve",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: { description: "Memory retrieval", stability: "stable" },
      });

      const defaultProvider: CapabilityProvider = {
        providerId: "@modus/project-memory",
        providerVersion: "1.0.0",
        capabilityId: "memory.retrieve",
        capabilityApiVersion: "1.0",
        trustLevel: "core",
        permissions: {},
        implementation: { execute: async () => ["default memory"] },
        registeredAt: new Date(),
        metadata: {},
      };

      const communityProvider: CapabilityProvider = {
        providerId: "@community/vector-memory",
        providerVersion: "2.1.0",
        capabilityId: "memory.retrieve",
        capabilityApiVersion: "1.0",
        trustLevel: "community",
        permissions: {},
        implementation: { execute: async () => ["vector memory"] },
        registeredAt: new Date(),
        metadata: {},
      };

      registry.registerProvider(defaultProvider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      registry.registerProvider(communityProvider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      expect(registry.getActiveProvider("memory.retrieve")?.providerId).toBe(
        "@modus/project-memory",
      );
      expect(registry.listProviders("memory.retrieve").length).toBe(2);

      const switchResult = registry.switchProvider("memory.retrieve", "@community/vector-memory");
      expect(switchResult.from).toBe("@modus/project-memory");
      expect(switchResult.to).toBe("@community/vector-memory");
      expect(registry.getActiveProvider("memory.retrieve")?.providerId).toBe(
        "@community/vector-memory",
      );
    });

    it("prohibits switching active provider on non-replaceable capabilities", () => {
      registry.registerCapability({
        id: "agent.loop",
        apiVersion: "1.0",
        replaceable: false, // Invariant: runtime core loop cannot be replaced
        dependencies: [],
        metadata: { description: "Core loop", stability: "stable" },
      });

      const coreProvider: CapabilityProvider = {
        providerId: "@modus/core-loop",
        providerVersion: "1.0.0",
        capabilityId: "agent.loop",
        capabilityApiVersion: "1.0",
        trustLevel: "core",
        permissions: {},
        implementation: { execute: () => "loop" },
        registeredAt: new Date(),
        metadata: {},
      };

      registry.registerProvider(coreProvider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      const foreignProvider: CapabilityProvider = {
        providerId: "@attacker/hijack-loop",
        providerVersion: "1.0.0",
        capabilityId: "agent.loop",
        capabilityApiVersion: "1.0",
        trustLevel: "community",
        permissions: {},
        implementation: { execute: () => "hijacked" },
        registeredAt: new Date(),
        metadata: {},
      };

      // A second, different provider cannot even be listed on a
      // non-replaceable capability (hijack refused at registration).
      expect(() => {
        registry.registerProvider(foreignProvider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      }).toThrow(CapabilityConflictError);
      expect(registry.getActiveProvider("agent.loop")?.providerId).toBe("@modus/core-loop");
      expect(registry.listProviders("agent.loop").length).toBe(1);

      expect(() => {
        registry.switchProvider("agent.loop", "@attacker/hijack-loop");
      }).toThrow(CapabilityConflictError);
    });

    it("rejects replacement by the same provider ID on a non-replaceable capability", () => {
      const implementation = { execute: () => "core" };
      registry.registerCapability({
        id: "agent.loop",
        apiVersion: "1.0",
        replaceable: false,
        dependencies: [],
        metadata: { description: "Core loop" },
      });
      registry.registerProvider(
        {
          providerId: "@modus/core-loop",
          providerVersion: "1.0.0",
          capabilityId: "agent.loop",
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation,
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      expect(() =>
        registry.registerProvider(
          {
            providerId: "@modus/core-loop",
            providerVersion: "1.0.0",
            capabilityId: "agent.loop",
            capabilityApiVersion: "1.0",
            trustLevel: "community",
            permissions: {},
            implementation: { execute: () => "hijacked" },
            registeredAt: new Date(),
            metadata: {},
          },
          HOST_CAPABILITY_REGISTRATION_AUTHORITY,
        ),
      ).toThrow(CapabilityConflictError);
      expect(registry.getActiveProvider("agent.loop")?.implementation).not.toBe(implementation);
      expect(registry.listProviders("agent.loop")).toHaveLength(1);
    });

    it("prohibits changing the active provider on non-replaceable capabilities", () => {
      registry.registerCapability({
        id: "agent.loop",
        apiVersion: "1.0",
        replaceable: false,
        dependencies: [],
        metadata: { description: "Core loop", stability: "stable" },
      });

      registry.registerProvider(
        {
          providerId: "@modus/core-loop",
          providerVersion: "1.0.0",
          capabilityId: "agent.loop",
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation: { execute: () => "loop" },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      // Activation switch to anything else is refused, even unregistered ids.
      expect(() => {
        registry.activateProvider("agent.loop", "@attacker/hijack-loop");
      }).toThrow(CapabilityConflictError);
      expect(registry.getActiveProvider("agent.loop")?.providerId).toBe("@modus/core-loop");

      // Initial activation and idempotent re-activation stay allowed.
      const fresh = new CapabilityRegistry();
      fresh.registerCapability({
        id: "agent.loop",
        apiVersion: "1.0",
        replaceable: false,
        dependencies: [],
        metadata: { description: "Core loop", stability: "stable" },
      });
      fresh.registerProvider(
        {
          providerId: "@modus/core-loop",
          providerVersion: "1.0.0",
          capabilityId: "agent.loop",
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation: { execute: () => "loop" },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );
      expect(() => {
        fresh.activateProvider("agent.loop", "@modus/core-loop");
      }).not.toThrow();
      expect(fresh.getActiveProvider("agent.loop")?.providerId).toBe("@modus/core-loop");
    });

    it("ignores attempts to flip the replaceable flag via re-registration", () => {
      registry.registerCapability({
        id: "agent.loop",
        apiVersion: "1.0",
        replaceable: false,
        dependencies: [],
        metadata: { description: "Core loop", stability: "stable" },
      });

      // Same id + version is a silent no-op: the invariant cannot be flipped.
      registry.registerCapability({
        id: "agent.loop",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: { description: "Core loop", stability: "stable" },
      });

      expect(registry.getCapability("agent.loop")?.replaceable).toBe(false);
    });
  });

  describe("9.3 — Execution and Provenance Tracking", () => {
    it("executes capability, records execution trace, and measures latency", async () => {
      registry.registerCapability({
        id: "model.select",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: { description: "Model selector", stability: "stable" },
      });

      registry.registerProvider(
        {
          providerId: "@modus/router",
          providerVersion: "1.0.0",
          capabilityId: "model.select",
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation: {
            execute: async (ctx: { task: string }) => {
              return { model: ctx.task === "code" ? "claude-3-7-sonnet" : "gemini-2.5-pro" };
            },
          },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      const res = await registry.execute<{ task: string }, { model: string }>("model.select", {
        task: "code",
      });
      expect(res.model).toBe("claude-3-7-sonnet");

      const provenance = registry.getProvenance("model.select");
      expect(provenance.usageCount).toBe(1);
      expect(provenance.errorRate).toBe(0);
      expect(provenance.activeProvider.id).toBe("@modus/router");
      expect(provenance.lastUsed).toBeDefined();

      const traces = registry.getTraces("model.select");
      expect(traces.length).toBe(1);
      expect(traces[0]?.success).toBe(true);
      expect(traces[0]?.providerId).toBe("@modus/router");
      expect(traces[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("records error provenance when a provider execution fails", async () => {
      registry.registerCapability({
        id: "tools.search",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: { description: "Search tool", stability: "stable" },
      });

      registry.registerProvider(
        {
          providerId: "@modus/failing-search",
          providerVersion: "0.1.0",
          capabilityId: "tools.search",
          capabilityApiVersion: "1.0",
          trustLevel: "local",
          permissions: {},
          implementation: {
            execute: async () => {
              throw new Error("Search index corrupted");
            },
          },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      await expect(registry.execute("tools.search", {})).rejects.toThrow("Search index corrupted");

      const provenance = registry.getProvenance("tools.search");
      expect(provenance.usageCount).toBe(1);
      expect(provenance.errorRate).toBe(1.0); // 100% failure rate

      const traces = registry.getTraces("tools.search");
      expect(traces[0]?.success).toBe(false);
      expect(traces[0]?.error).toBe("Search index corrupted");
    });

    it("throws NoProviderError when executing an unregistered capability", async () => {
      await expect(registry.execute("nonexistent.capability", {})).rejects.toThrow(NoProviderError);
    });
  });

  describe("9.4 — Discovery API and CLI Presentation", () => {
    it("produces structured JSON discovery output and CLI table format", () => {
      registry.registerCapability({
        id: "memory.retrieve",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: { description: "Retrieve memory", stability: "stable" },
      });

      registry.registerProvider(
        {
          providerId: "@modus/project-memory",
          providerVersion: "1.0.0",
          capabilityId: "memory.retrieve",
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation: { execute: () => [] },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      registry.registerProvider(
        {
          providerId: "@community/vector-memory",
          providerVersion: "2.1.0",
          capabilityId: "memory.retrieve",
          capabilityApiVersion: "1.0",
          trustLevel: "community",
          permissions: {},
          implementation: { execute: () => [] },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      const discovery = new CapabilityDiscovery(registry);
      const json = discovery.listJson();

      expect(json.capabilities.length).toBe(1);
      expect(json.capabilities[0]?.id).toBe("memory.retrieve");
      expect(json.capabilities[0]?.activeProvider?.id).toBe("@modus/project-memory");
      expect(json.capabilities[0]?.alternativeProviders.length).toBe(1);
      expect(json.capabilities[0]?.alternativeProviders[0]?.id).toBe("@community/vector-memory");

      const table = discovery.formatTable();
      expect(table).toContain("CAPABILITY");
      expect(table).toContain("memory.retrieve");
      expect(table).toContain("@modus/project-memory@1.0.0");
      expect(table).toContain("@community/vector-memory@2.1.0");

      const switchRes = discovery.switch("memory.retrieve", "@community/vector-memory");
      expect(switchRes.newProvider).toBe("@community/vector-memory");
      expect(switchRes.message).toContain("Switching memory.retrieve provider:");
    });
  });

  describe("9.5 — Standard Core Capabilities Suite (21 Capabilities)", () => {
    it("registers all 21 standard core capabilities with default core providers", () => {
      registerCoreCapabilities(registry);

      expect(CORE_CAPABILITIES.length).toBe(21);
      const list = registry.listCapabilities();
      expect(list.length).toBe(21);

      // Invariants check
      const nonReplaceable = list.filter((c) => !c.replaceable).map((c) => c.id);
      expect(nonReplaceable).toEqual(["agent.loop", "agent.pause", "agent.resume"]);

      // Check all have active core providers
      for (const cap of CORE_CAPABILITIES) {
        const active = registry.getActiveProvider(cap.id);
        expect(active).toBeDefined();
        expect(active?.trustLevel).toBe("core");
      }
    });

    it("reports core capabilities without a productive implementation as unavailable", async () => {
      registerCoreCapabilities(registry);

      expect(registry.getActiveProvider("memory.retrieve")?.permissions).toEqual({});
      await expect(registry.execute("memory.retrieve", { query: "test query" })).rejects.toThrow(
        CapabilityUnavailableError,
      );
    });
  });

  describe("9.6 — PiSdkRuntime Integration & Feature Flags", () => {
    it("keeps the mutable CapabilityRegistry private to PiSdkRuntime", () => {
      setFeatureFlagOverrides({
        MODUS_CAPABILITY_REGISTRY: true,
      });

      const runtime = new PiSdkRuntime();
      expect("getCapabilityRegistry" in runtime).toBe(false);
      expect("capabilityRegistry" in runtime).toBe(false);
    });
  });
});
