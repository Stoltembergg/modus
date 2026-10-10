import {
  registerTrustedPluginCatalogEntry,
  resolveTrustedPluginCatalogEntry,
} from "./plugin-catalog-internal";
import type { PluginManifest, PluginManifestDescriptor, PluginManifestInput } from "./plugin-types";
import { contextEnginePluginManifest } from "./plugins/context-engine-plugin";
import { failureIntelPluginManifest } from "./plugins/failure-intel-plugin";
import { groupsPluginManifest } from "./plugins/groups-plugin";
import { memoryPluginManifest } from "./plugins/memory-plugin";
import { modelRouterPluginManifest } from "./plugins/model-router-plugin";
import { verifierPluginManifest } from "./plugins/verifier-plugin";

export type HostPluginTrust = "core" | "official";

/** Internal trusted source entry. Public catalog methods return HostPluginEntryDescriptor. */
export interface HostPluginEntry {
  readonly manifest: PluginManifest;
  readonly trustLevel: HostPluginTrust;
}

export interface HostPluginEntryDescriptor {
  readonly manifest: PluginManifestDescriptor;
  readonly trustLevel: HostPluginTrust;
}

export interface PluginManifestCatalog {
  authorize(manifest: PluginManifestInput): HostPluginEntryDescriptor | undefined;
  resolve(id: string, version: string): HostPluginEntryDescriptor | undefined;
  resolveById?(id: string): HostPluginEntryDescriptor | undefined;
  listEntries?(): readonly HostPluginEntryDescriptor[];
}

const descriptorsBySource = new WeakMap<PluginManifest, PluginManifestDescriptor>();

function cloneSafeMetadata(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing) return existing;
    const snapshot: unknown[] = [];
    seen.set(value, snapshot);
    for (const item of value) snapshot.push(cloneSafeMetadata(item, seen) ?? null);
    return snapshot;
  }
  if (typeof value !== "object") return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const existing = seen.get(value);
  if (existing) return existing;
  const snapshot: Record<string, unknown> = {};
  seen.set(value, snapshot);
  for (const [key, item] of Object.entries(value)) {
    const safeItem = cloneSafeMetadata(item, seen);
    if (safeItem !== undefined) snapshot[key] = safeItem;
  }
  return snapshot;
}

function freezeManifestGraph(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) freezeManifestGraph(descriptor.value, seen);
  }
  Object.freeze(value);
}

export function createPluginManifestDescriptor(manifest: PluginManifest): PluginManifestDescriptor {
  const existing = descriptorsBySource.get(manifest);
  if (existing) return existing;
  const descriptor: PluginManifestDescriptor = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    trustLevel: manifest.trustLevel,
    provides: manifest.provides.map(({ capability, apiVersion, config }) => ({
      capability,
      apiVersion,
      ...(config ? { config: cloneSafeMetadata(config) as Record<string, unknown> } : {}),
    })),
    requires: cloneSafeMetadata(manifest.requires) as PluginManifestDescriptor["requires"],
    permissions: cloneSafeMetadata(manifest.permissions) as PluginManifestDescriptor["permissions"],
  };
  freezeManifestGraph(descriptor);
  descriptorsBySource.set(manifest, descriptor);
  return descriptor;
}

export class HostPluginCatalog implements PluginManifestCatalog {
  #entries: ReadonlyMap<string, HostPluginEntryDescriptor>;

  constructor(entries: readonly HostPluginEntry[]) {
    const byKey = new Map<string, HostPluginEntryDescriptor>();
    for (const entry of entries) {
      freezeManifestGraph(entry.manifest);
      const key = `${entry.manifest.id}@${entry.manifest.version}`;
      if (byKey.has(key)) throw new Error(`Duplicate host plugin catalog entry: ${key}`);
      const manifest =
        descriptorsBySource.get(entry.manifest) ?? createPluginManifestDescriptor(entry.manifest);
      registerTrustedPluginCatalogEntry(this, entry, manifest);
      byKey.set(key, Object.freeze({ manifest, trustLevel: entry.trustLevel }));
    }
    this.#entries = byKey;
  }

  public authorize(manifest: PluginManifestInput): HostPluginEntryDescriptor | undefined {
    const entry = resolveTrustedPluginCatalogEntry(this, manifest);
    return entry ? this.#entries.get(`${entry.manifest.id}@${entry.manifest.version}`) : undefined;
  }

  public resolve(id: string, version: string): HostPluginEntryDescriptor | undefined {
    return this.#entries.get(`${id}@${version}`);
  }

  public resolveById(id: string): HostPluginEntryDescriptor | undefined {
    return Array.from(this.#entries.values()).find((entry) => entry.manifest.id === id);
  }

  public listEntries(): readonly HostPluginEntryDescriptor[] {
    return Object.freeze(Array.from(this.#entries.values()));
  }
}

const builtInPluginSources: readonly HostPluginEntry[] = Object.freeze([
  Object.freeze({ manifest: memoryPluginManifest, trustLevel: "core" as const }),
  Object.freeze({ manifest: modelRouterPluginManifest, trustLevel: "core" as const }),
  Object.freeze({ manifest: contextEnginePluginManifest, trustLevel: "core" as const }),
  Object.freeze({ manifest: verifierPluginManifest, trustLevel: "core" as const }),
  Object.freeze({ manifest: failureIntelPluginManifest, trustLevel: "core" as const }),
  Object.freeze({ manifest: groupsPluginManifest, trustLevel: "core" as const }),
]);

export const BUILT_IN_PLUGIN_CATALOG = new HostPluginCatalog(builtInPluginSources);
export const BUILT_IN_PLUGIN_ENTRIES = BUILT_IN_PLUGIN_CATALOG.listEntries();
