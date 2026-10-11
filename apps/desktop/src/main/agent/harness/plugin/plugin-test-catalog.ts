import type {
  HostPluginEntry,
  HostPluginEntryDescriptor,
  HostPluginTrust,
  PluginManifestCatalog,
} from "./plugin-catalog";
import { createPluginManifestDescriptor } from "./plugin-catalog";
import { registerTrustedPluginCatalogEntry } from "./plugin-catalog-internal";
import type { PluginManifest, PluginManifestInput } from "./plugin-types";

/** Test-only catalog for explicitly authorized synthetic manifests. */
export class TestPluginCatalog implements PluginManifestCatalog {
  private readonly entries = new Map<string, HostPluginEntry>();
  private readonly descriptors = new Map<string, HostPluginEntryDescriptor>();

  public add(manifest: PluginManifest, trustLevel: HostPluginTrust = "core"): void {
    const key = `${manifest.id}@${manifest.version}`;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.manifest === manifest && existing.trustLevel === trustLevel) return;
      throw new Error(`Duplicate test plugin catalog entry: ${key}`);
    }
    const entry = { manifest, trustLevel };
    this.entries.set(key, entry);
    const descriptor = this.createEntryDescriptor(entry);
    this.descriptors.set(key, descriptor);
    registerTrustedPluginCatalogEntry(this, entry, descriptor.manifest);
  }

  public authorize(manifest: PluginManifestInput): HostPluginEntryDescriptor | undefined {
    const entry = this.resolve(manifest.id, manifest.version);
    if (!entry) return undefined;
    const source = this.entries.get(`${manifest.id}@${manifest.version}`);
    const descriptor = this.descriptors.get(`${manifest.id}@${manifest.version}`);
    return source?.manifest === manifest || descriptor?.manifest === manifest
      ? descriptor
      : undefined;
  }

  public resolve(id: string, version: string): HostPluginEntryDescriptor | undefined {
    return this.descriptors.get(`${id}@${version}`);
  }

  public resolveById(id: string): HostPluginEntryDescriptor | undefined {
    return Array.from(this.descriptors.values()).find((entry) => entry.manifest.id === id);
  }

  public listEntries(): readonly HostPluginEntryDescriptor[] {
    return Object.freeze(Array.from(this.descriptors.values()));
  }

  private createEntryDescriptor(entry: HostPluginEntry): HostPluginEntryDescriptor {
    return Object.freeze({
      manifest: createPluginManifestDescriptor(entry.manifest),
      trustLevel: entry.trustLevel,
    });
  }
}
