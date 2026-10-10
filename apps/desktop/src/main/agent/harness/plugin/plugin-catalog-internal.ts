import type { HostPluginEntry, PluginManifestCatalog } from "./plugin-catalog";
import type { PluginManifest, PluginManifestDescriptor, PluginManifestInput } from "./plugin-types";

const trustedEntriesByCatalog = new WeakMap<PluginManifestCatalog, Map<string, HostPluginEntry>>();
const sourcesByDescriptor = new WeakMap<PluginManifestDescriptor, PluginManifest>();

/** @internal Trusted loader wiring. This module is not re-exported from the plugin API. */
export function registerTrustedPluginCatalogEntry(
  catalog: PluginManifestCatalog,
  entry: HostPluginEntry,
  descriptor: PluginManifestDescriptor,
): void {
  let entries = trustedEntriesByCatalog.get(catalog);
  if (!entries) {
    entries = new Map();
    trustedEntriesByCatalog.set(catalog, entries);
  }
  entries.set(`${entry.manifest.id}@${entry.manifest.version}`, entry);
  sourcesByDescriptor.set(descriptor, entry.manifest);
}

/** @internal Resolve an exact source only for trusted in-process loader wiring. */
export function resolveTrustedPluginCatalogEntry(
  catalog: PluginManifestCatalog,
  input: PluginManifestInput,
): HostPluginEntry | undefined {
  const entries = trustedEntriesByCatalog.get(catalog);
  if (!entries) return undefined;
  const entry = entries.get(`${input.id}@${input.version}`);
  if (!entry) return undefined;
  const source = sourcesByDescriptor.get(input as PluginManifestDescriptor);
  return entry.manifest === input || entry.manifest === source ? entry : undefined;
}

/** @internal Resolve a host-owned source for trusted lifecycle wiring. */
export function resolveTrustedPluginCatalogEntryById(
  catalog: PluginManifestCatalog,
  id: string,
  version?: string,
): HostPluginEntry | undefined {
  const entries = trustedEntriesByCatalog.get(catalog);
  if (!entries) return undefined;
  return Array.from(entries.values()).find(
    (entry) =>
      entry.manifest.id === id && (version === undefined || entry.manifest.version === version),
  );
}
