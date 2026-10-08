import type { HostPluginEntry, HostPluginTrust, PluginManifestCatalog } from './plugin-catalog';
import type { PluginManifest } from './plugin-types';

/** Test-only catalog for explicitly authorized synthetic manifests. */
export class TestPluginCatalog implements PluginManifestCatalog {
  private readonly entries = new Map<string, HostPluginEntry>();

  public add(manifest: PluginManifest, trustLevel: HostPluginTrust = 'core'): void {
    const key = `${manifest.id}@${manifest.version}`;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.manifest === manifest && existing.trustLevel === trustLevel) return;
      throw new Error(`Duplicate test plugin catalog entry: ${key}`);
    }
    this.entries.set(key, { manifest, trustLevel });
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
