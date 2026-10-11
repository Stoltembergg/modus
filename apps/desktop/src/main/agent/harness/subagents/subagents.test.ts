import { beforeEach, describe, expect, it } from "vitest";
import { ModusNativeSubagentProvider } from "./modus-native-provider";
import type { SubagentProvider } from "./subagent-provider";
import { SubagentProviderRegistry } from "./subagent-provider-registry";

describe("Subagents Subsystem — ModusNativeProvider & SubagentProviderRegistry", () => {
  beforeEach(() => {
    SubagentProviderRegistry.resetInstance();
  });

  describe("ModusNativeSubagentProvider", () => {
    it("advertises no capabilities without a wired delegate", () => {
      const provider = new ModusNativeSubagentProvider();
      expect(provider.name).toBe("modus-native");
      expect(provider.capabilities.supportsWorktrees).toBe(false);
      expect(provider.capabilities.supportsWait).toBe(false);
      expect(provider.capabilities.supportsStreaming).toBe(false);
      expect(provider.capabilities.maxConcurrent).toBe(0);
    });

    it("advertises native capabilities once a delegate is wired", () => {
      const provider = new ModusNativeSubagentProvider({
        spawnSubagent: async () => ({ subagentId: "d1", status: "spawned" as const }),
      });
      expect(provider.capabilities.supportsWorktrees).toBe(true);
      expect(provider.capabilities.supportsWait).toBe(true);
      expect(provider.capabilities.supportsStreaming).toBe(true);
      expect(provider.capabilities.maxConcurrent).toBe(6);
    });

    it("fails closed on spawn without a delegate instead of fabricating success", async () => {
      const provider = new ModusNativeSubagentProvider();

      const spawnRes = await provider.spawn({
        role: "investigator",
        task: "Investigate database schema",
        isolation: "worktree",
      });

      expect(spawnRes.status).toBe("failed");
      expect(spawnRes.errorMessage).toContain("no dispatch delegate");

      const status = await provider.status(spawnRes.subagentId);
      expect(status.state).toBe("failed");

      const waitRes = await provider.wait(spawnRes.subagentId);
      expect(waitRes.success).toBe(false);
    });

    it("delegates full lifecycle (spawn, status, wait, stop) when wired", async () => {
      const stopped: string[] = [];
      const states = new Map<string, "running" | "completed" | "aborted">();
      const customDelegate = {
        spawnSubagent: async () => {
          states.set("custom-123", "running");
          return { subagentId: "custom-123", status: "spawned" as const };
        },
        waitSubagent: async () => {
          states.set("custom-123", "completed");
          return {
            subagentId: "custom-123",
            output: "Custom harvested output",
            success: true,
          };
        },
        stopSubagent: async (id: string) => {
          stopped.push(id);
          states.set(id, "aborted");
        },
        getSubagentStatus: async (id: string) => ({
          subagentId: id,
          state: states.get(id) ?? ("failed" as const),
        }),
      };

      const provider = new ModusNativeSubagentProvider(customDelegate);
      const res = await provider.spawn({ role: "custom", task: "Custom task" });
      expect(res.subagentId).toBe("custom-123");

      const statusRunning = await provider.status("custom-123");
      expect(statusRunning.state).toBe("running");

      const waitRes = await provider.wait("custom-123");
      expect(waitRes.success).toBe(true);
      expect(waitRes.output).toBe("Custom harvested output");

      await provider.stop("custom-123");
      expect(stopped).toEqual(["custom-123"]);
      expect((await provider.status("custom-123")).state).toBe("aborted");
    });

    it("stop() without a delegate is a harmless no-op", async () => {
      const provider = new ModusNativeSubagentProvider();
      await provider.stop("non-existent-id");
      const status = await provider.status("non-existent-id");
      expect(status.state).toBe("failed");
    });

    it("returns error on wait() for non-existent subagents", async () => {
      const provider = new ModusNativeSubagentProvider();
      const waitRes = await provider.wait("non-existent-id");
      expect(waitRes.success).toBe(false);
      expect(waitRes.error).toContain("not found");
    });

    it("uses custom delegates when provided", async () => {
      const customDelegate = {
        spawnSubagent: async () => ({
          subagentId: "custom-123",
          status: "spawned" as const,
        }),
        waitSubagent: async () => ({
          subagentId: "custom-123",
          output: "Custom harvested output",
          success: true,
        }),
      };

      const provider = new ModusNativeSubagentProvider(customDelegate);
      const res = await provider.spawn({ role: "custom", task: "Custom task" });
      expect(res.subagentId).toBe("custom-123");

      const waitRes = await provider.wait("custom-123");
      expect(waitRes.output).toBe("Custom harvested output");
    });
  });

  describe("SubagentProviderRegistry", () => {
    it("resolves default provider as modus-native", () => {
      const registry = SubagentProviderRegistry.getInstance();
      const defaultProvider = registry.getDefaultProvider();
      expect(defaultProvider.name).toBe("modus-native");
      expect(registry.listProviders()).toContain("modus-native");
    });

    it("registers and retrieves custom subagent providers", () => {
      const registry = SubagentProviderRegistry.getInstance();

      const mockProvider: SubagentProvider = {
        name: "mock-sandbox",
        capabilities: {
          supportsWorktrees: false,
          supportsWait: true,
          supportsStreaming: false,
          maxConcurrent: 2,
        },
        spawn: async () => ({ subagentId: "m1", status: "spawned" }),
        wait: async () => ({ subagentId: "m1", success: true }),
        stop: async () => {},
        status: async () => ({ subagentId: "m1", state: "completed" }),
      };

      registry.register(mockProvider);
      expect(registry.listProviders()).toContain("mock-sandbox");

      const retrieved = registry.getProvider("mock-sandbox");
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("mock-sandbox");

      // Allows setting custom default
      expect(registry.setDefaultProvider("mock-sandbox")).toBe(true);
      expect(registry.getDefaultProvider().name).toBe("mock-sandbox");

      // Unregister custom provider
      expect(registry.unregister("mock-sandbox")).toBe(true);
      expect(registry.getProvider("mock-sandbox")).toBeUndefined();
    });

    it("prevents unregistering the core default provider", () => {
      const registry = SubagentProviderRegistry.getInstance();
      const unregistered = registry.unregister("modus-native");
      expect(unregistered).toBe(false);
      expect(registry.getProvider("modus-native")).toBeDefined();
    });
  });
});
