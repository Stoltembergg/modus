import type { PluginManifest } from "./plugin-types";
import { contextEnginePluginManifest } from "./plugins/context-engine-plugin";
import { failureIntelPluginManifest } from "./plugins/failure-intel-plugin";
import { groupsPluginManifest } from "./plugins/groups-plugin";
import { memoryPluginManifest } from "./plugins/memory-plugin";
import { modelRouterPluginManifest } from "./plugins/model-router-plugin";
import { verifierPluginManifest } from "./plugins/verifier-plugin";

export type HostPluginTrust = "core" | "official";

export interface HostPluginEntry {
  readonly manifest: PluginManifest;
  readonly trustLevel: HostPluginTrust;
}

export interface PluginManifestCatalog {
  authorize(manifest: PluginManifest): HostPluginEntry | undefined;
  resolve(id: string, version: string): HostPluginEntry | undefined;
  resolveById?(id: string): HostPluginEntry | undefined;
}

export class HostPluginCatalog implements PluginManifestCatalog {
  private readonly entries: ReadonlyMap<string, HostPluginEntry>;

  constructor(entries: readonly HostPluginEntry[]) {
    const byKey = new Map<string, HostPluginEntry>();
    for (const entry of entries) {
      const key = `${entry.manifest.id}@${entry.manifest.version}`;
      if (byKey.has(key)) throw new Error(`Duplicate host plugin catalog entry: ${key}`);
      byKey.set(key, Object.freeze({ manifest: entry.manifest, trustLevel: entry.trustLevel }));
    }
    this.entries = byKey;
  }

  public authorize(manifest: PluginManifest): HostPluginEntry | undefined {
    const entry = this.resolve(manifest.id, manifest.version);
    return entry?.manifest === manifest ? entry : undefined;
  }

  public resolve(id: string, version: string): HostPluginEntry | undefined {
    return this.entries.get(`${id}@${version}`);
  }

  public resolveById(id: string): HostPluginEntry | undefined {
    return Array.from(this.entries.values()).find((entry) => entry.manifest.id === id);
  }
}

export const BUILT_IN_PLUGIN_ENTRIES: readonly HostPluginEntry[] = Object.freeze([
  Object.freeze({ manifest: memoryPluginManifest, trustLevel: "core" as const }),
  Object.freeze({ manifest: modelRouterPluginManifest, trustLevel: "core" as const }),
  Object.freeze({ manifest: contextEnginePluginManifest, trustLevel: "core" as const }),
  Object.freeze({ manifest: verifierPluginManifest, trustLevel: "core" as const }),
  Object.freeze({ manifest: failureIntelPluginManifest, trustLevel: "core" as const }),
  Object.freeze({ manifest: groupsPluginManifest, trustLevel: "core" as const }),
]);

export const BUILT_IN_PLUGIN_CATALOG = new HostPluginCatalog(BUILT_IN_PLUGIN_ENTRIES);
