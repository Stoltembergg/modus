import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityRegistry } from "../capability/capability-registry";
import { PluginLifecycleService } from "./plugin-lifecycle-service";
import { PluginLoader } from "./plugin-loader";
import { PluginStateStore } from "./plugin-state-store";

describe("retired built-in plugins", () => {
  afterEach(() => vi.restoreAllMocks());

  it("startup sync drops a stale @modus/groups row without warning or an error state", async () => {
    const store = new PluginStateStore(new DatabaseSync(":memory:"));
    store.savePlugin({
      id: "@modus/groups",
      version: "1.0.0",
      state: "enabled",
      trust_level: "core",
      installed_at: new Date().toISOString(),
      last_enabled: null,
      config: null,
    });
    store.recordEvent("@modus/groups", "enabled", { version: "1.0.0" });
    const registry = new CapabilityRegistry();
    const service = new PluginLifecycleService(store, new PluginLoader(registry), registry);
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");

    await service.syncOnStartup();

    expect(store.getPlugin("@modus/groups")).toBeNull();
    expect((await service.list()).map((record) => record.id)).not.toContain("@modus/groups");
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(logged).not.toContain("@modus/groups");
    store.close();
  });
});
