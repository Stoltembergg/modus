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

export interface BootstrapOptions {
  /** Leave built-ins unloaded until lifecycle state has been reconciled. */
  deferActivation?: boolean;
}

/**
 * Bootstraps built-in plugins in the host catalog's declared order.
 */
export async function bootstrapModusPlugins(
  registry: CapabilityRegistry = new CapabilityRegistry(),
  loader?: PluginLoader,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const pluginLoader = loader ?? new PluginLoader(registry);

  // 1. First ensure all 21 core capabilities are registered in the registry.
  // Avoid re-registering providers when the runtime already bootstrapped them:
  // non-replaceable provider identity is intentionally immutable.
  if (!CORE_CAPABILITIES.every((capability) => registry.getCapability(capability.id))) {
    registerCoreCapabilities(registry);
  }

  // 2. Load internal plugins in the host catalog's declared order.
  const orderedManifests = BUILT_IN_PLUGIN_ENTRIES.map((entry) => entry.manifest);

  const loadedPlugins: string[] = [];
  for (const manifest of orderedManifests) {
    if (options.deferActivation) continue;
    await pluginLoader.load(manifest);
    loadedPlugins.push(manifest.id);
    await pluginLoader.enable(manifest.id);
  }

  return {
    registry,
    loader: pluginLoader,
    loadedPlugins,
  };
}
