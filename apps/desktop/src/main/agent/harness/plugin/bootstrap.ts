/**
 * Modus Harness Evolution — Fase 10: Bootstrap Sequence
 * Bootstraps core capabilities and loads internal plugins in topological dependency order.
 */

import { CapabilityRegistry } from "../capability/capability-registry";
import { CORE_CAPABILITIES, registerCoreCapabilities } from "../capability/core-capabilities";
import { BUILT_IN_PLUGIN_ENTRIES } from "./plugin-catalog";
import { PluginLoader } from "./plugin-loader";

export interface BootstrapResult {
  registry: CapabilityRegistry;
  loader: PluginLoader;
  loadedPlugins: string[];
}

/**
 * Bootstraps all Modus internal plugins in strict dependency order.
 */
export async function bootstrapModusPlugins(
  registry: CapabilityRegistry = new CapabilityRegistry(),
  loader?: PluginLoader,
): Promise<BootstrapResult> {
  const pluginLoader = loader ?? new PluginLoader(registry);

  // 1. First ensure all 21 core capabilities are registered in the registry.
  // Avoid re-registering providers when the runtime already bootstrapped them:
  // non-replaceable provider identity is intentionally immutable.
  if (!CORE_CAPABILITIES.every((capability) => registry.getCapability(capability.id))) {
    registerCoreCapabilities(registry);
  }

  // 2. Load internal plugins in topological dependency order
  // Order:
  // - Memory (no deps)
  // - Model Router (no deps)
  // - Context Engine (requires memory)
  // - Verifier (requires context)
  // - Failure Intelligence (requires verifier)
  // - Groups (requires context)
  const orderedManifests = BUILT_IN_PLUGIN_ENTRIES.map((entry) => entry.manifest);

  const loadedPlugins: string[] = [];
  for (const manifest of orderedManifests) {
    await pluginLoader.load(manifest);
    await pluginLoader.enable(manifest.id);
    loadedPlugins.push(manifest.id);
  }

  return {
    registry,
    loader: pluginLoader,
    loadedPlugins,
  };
}
