/**
 * Modus Harness Evolution — Fase 10: Modus Internal Plugins
 * Plugin Loader & Lifecycle Manager.
 */

import semver from "semver";
import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from "../capability/capability-registration-authority";
import type { CapabilityRegistry } from "../capability/capability-registry";
import type {
  Capability,
  CapabilityProvider,
  ProviderRegistrationCheckpoint,
  TrustLevel,
} from "../capability/capability-types";
import type {
  HostPluginEntry,
  HostPluginEntryDescriptor,
  PluginManifestCatalog,
} from "./plugin-catalog";
import { BUILT_IN_PLUGIN_CATALOG, createPluginManifestDescriptor } from "./plugin-catalog";
import {
  resolveTrustedPluginCatalogEntry,
  resolveTrustedPluginCatalogEntryById,
} from "./plugin-catalog-internal";
import type {
  LoadedPlugin,
  PluginManifest,
  PluginManifestDescriptor,
  PluginManifestInput,
  PluginStatus,
} from "./plugin-types";
import { PluginDependencyError, PluginLifecycleError, PluginValidationError } from "./plugin-types";

interface InternalLoadedPlugin {
  manifest: PluginManifest;
  status: PluginStatus;
  loadedAt: Date;
  error?: string | undefined;
  publicState?: { status: PluginStatus; error?: string | undefined } | undefined;
}

function normalizeApiVersion(version: string): string | undefined {
  const partial = version.match(/^(\d+)\.(\d+)$/);
  const shorthand = version.match(/^(\d+)$/);
  const normalized = partial
    ? `${partial[1]}.${partial[2]}.0`
    : shorthand
      ? `${shorthand[1]}.0.0`
      : version;
  return semver.valid(normalized, { loose: true }) ?? undefined;
}

function isApiVersionSatisfied(registered: string, requiredRange: string): boolean {
  const normalized = normalizeApiVersion(registered);
  return (
    normalized !== undefined &&
    semver.validRange(requiredRange, { loose: true }) !== null &&
    semver.satisfies(normalized, requiredRange, { loose: true })
  );
}

interface RegistryPluginLoaderState {
  plugins: Map<string, InternalLoadedPlugin>;
  publicViews: WeakMap<InternalLoadedPlugin, LoadedPlugin>;
  publicManifestBySource: WeakMap<PluginManifest, PluginManifestDescriptor>;
  sourceManifestByPublic: WeakMap<object, PluginManifest>;
  loadingPluginIds: Set<string>;
  lifecycleOperations: Map<string, string>;
}

const pluginLoaderStateByRegistry = new WeakMap<CapabilityRegistry, RegistryPluginLoaderState>();

export class PluginLoader {
  private plugins: Map<string, InternalLoadedPlugin>;
  private publicViews: WeakMap<InternalLoadedPlugin, LoadedPlugin>;
  private loadingPluginIds: Set<string>;
  private lifecycleOperations: Map<string, string>;
  private publicManifestBySource: WeakMap<PluginManifest, PluginManifestDescriptor>;
  private sourceManifestByPublic: WeakMap<object, PluginManifest>;

  constructor(
    private registry: CapabilityRegistry,
    private catalog: PluginManifestCatalog = BUILT_IN_PLUGIN_CATALOG,
  ) {
    let state = pluginLoaderStateByRegistry.get(registry);
    if (!state) {
      state = {
        plugins: new Map<string, InternalLoadedPlugin>(),
        publicViews: new WeakMap<InternalLoadedPlugin, LoadedPlugin>(),
        publicManifestBySource: new WeakMap<PluginManifest, PluginManifestDescriptor>(),
        sourceManifestByPublic: new WeakMap<object, PluginManifest>(),
        loadingPluginIds: new Set<string>(),
        lifecycleOperations: new Map<string, string>(),
      };
      pluginLoaderStateByRegistry.set(registry, state);
    }
    this.plugins = state.plugins;
    this.publicViews = state.publicViews;
    this.publicManifestBySource = state.publicManifestBySource;
    this.sourceManifestByPublic = state.sourceManifestByPublic;
    this.loadingPluginIds = state.loadingPluginIds;
    this.lifecycleOperations = state.lifecycleOperations;
  }

  private reserveLifecycle(pluginId: string, operation: string): void {
    const activeOperation = this.lifecycleOperations.get(pluginId);
    if (activeOperation) {
      throw new PluginLifecycleError(`Plugin "${pluginId}" is already ${activeOperation}`);
    }
    this.lifecycleOperations.set(pluginId, operation);
  }

  private releaseLifecycle(pluginId: string): void {
    this.lifecycleOperations.delete(pluginId);
  }

  private publicManifest(manifest: PluginManifest): PluginManifestDescriptor {
    const existing = this.publicManifestBySource.get(manifest);
    if (existing) return existing;
    const descriptor = createPluginManifestDescriptor(manifest);
    this.publicManifestBySource.set(manifest, descriptor);
    this.sourceManifestByPublic.set(descriptor, manifest);
    return descriptor;
  }

  private authorizedEntry(manifest: PluginManifestInput): HostPluginEntry {
    const source =
      this.sourceManifestByPublic.get(manifest as object) ?? (manifest as PluginManifest);
    const authorization = this.catalog.authorize(source);
    if (!authorization) {
      throw new PluginValidationError(
        `Plugin manifest "${manifest.id}@${manifest.version}" is not authorized by the host catalog`,
      );
    }
    const trustedEntry = resolveTrustedPluginCatalogEntry(this.catalog, source);
    if (trustedEntry) return trustedEntry;
    if ("provides" in source && source.provides.some((provision) => provision.implementation)) {
      return { manifest: source as PluginManifest, trustLevel: authorization.trustLevel };
    }
    throw new PluginValidationError(
      `Plugin manifest "${manifest.id}@${manifest.version}" has no trusted executable source`,
    );
  }

  public authorizeManifest(manifest: PluginManifestInput): HostPluginEntryDescriptor {
    const entry = this.authorizedEntry(manifest);
    return Object.freeze({
      manifest: this.publicManifest(entry.manifest),
      trustLevel: entry.trustLevel,
    });
  }

  public resolveHostManifest(id: string, version: string): PluginManifestDescriptor | undefined {
    const entry = resolveTrustedPluginCatalogEntryById(this.catalog, id, version);
    return entry ? this.publicManifest(entry.manifest) : undefined;
  }

  public resolveHostManifestById(id: string): PluginManifestDescriptor | undefined {
    const entry = resolveTrustedPluginCatalogEntryById(this.catalog, id);
    return entry ? this.publicManifest(entry.manifest) : undefined;
  }

  public getRegistry(): CapabilityRegistry {
    return this.registry;
  }

  public validateManifest(input: PluginManifestInput): void {
    const manifest = this.sourceManifestByPublic.get(input as object) ?? (input as PluginManifest);
    if (!manifest.id || typeof manifest.id !== "string") {
      throw new PluginValidationError('Plugin manifest must contain a valid string "id"');
    }
    if (!manifest.version || typeof manifest.version !== "string") {
      throw new PluginValidationError(`Plugin "${manifest.id}" must specify a valid "version"`);
    }
    if (!semver.valid(manifest.version, { loose: true })) {
      throw new PluginValidationError(
        `Plugin "${manifest.id}" specifies invalid semantic version "${manifest.version}"`,
      );
    }
    if (!manifest.provides || !Array.isArray(manifest.provides) || manifest.provides.length === 0) {
      throw new PluginValidationError(
        `Plugin "${manifest.id}" must provide at least one capability in "provides"`,
      );
    }

    const validTrustLevels: TrustLevel[] = ["core", "official", "verified", "community", "local"];
    if (!validTrustLevels.includes(manifest.trustLevel)) {
      throw new PluginValidationError(
        `Plugin "${manifest.id}" specifies invalid trustLevel "${manifest.trustLevel}"`,
      );
    }

    if (!semver.validRange(manifest.requires.modus, { loose: true })) {
      throw new PluginValidationError(
        `Plugin "${manifest.id}" specifies invalid Modus version constraint "${manifest.requires.modus}"`,
      );
    }

    for (const requirement of manifest.requires.capabilities ?? []) {
      if (!semver.validRange(requirement.version, { loose: true })) {
        throw new PluginValidationError(
          `Plugin "${manifest.id}" specifies invalid capability version constraint "${requirement.version}" for "${requirement.capability}"`,
        );
      }
    }

    for (const provision of manifest.provides) {
      if (!provision.capability || !provision.apiVersion) {
        throw new PluginValidationError(
          `Plugin "${manifest.id}" contains invalid provision entry with missing capability or apiVersion`,
        );
      }
      if (!normalizeApiVersion(provision.apiVersion)) {
        throw new PluginValidationError(
          `Plugin "${manifest.id}" specifies invalid API version "${provision.apiVersion}" for "${provision.capability}"`,
        );
      }
      if (!provision.implementation) {
        throw new PluginValidationError(
          `Plugin "${manifest.id}" missing implementation for capability "${provision.capability}"`,
        );
      }
    }
  }

  public isApiVersionSatisfied(registered: string, requiredRange: string): boolean {
    return isApiVersionSatisfied(registered, requiredRange);
  }

  public checkDependencies(manifest: PluginManifestInput): void {
    if (!manifest.requires) return;

    if (manifest.requires.capabilities) {
      for (const req of manifest.requires.capabilities) {
        if (!semver.validRange(req.version, { loose: true })) {
          throw new PluginDependencyError(
            `Plugin "${manifest.id}" has invalid capability version constraint "${req.version}" for "${req.capability}"`,
          );
        }
        const capability = this.registry.getCapability(req.capability);
        if (!capability) {
          throw new PluginDependencyError(
            `Plugin "${manifest.id}" requires missing capability "${req.capability}" (version: ${req.version})`,
          );
        }
        if (!isApiVersionSatisfied(capability.apiVersion, req.version)) {
          throw new PluginDependencyError(
            `Plugin "${manifest.id}" requires ${req.capability}@${req.version} but registry provides ${capability.apiVersion}`,
          );
        }
        if (!this.registry.getActiveProvider(req.capability)) {
          throw new PluginDependencyError(
            `Plugin "${manifest.id}" requires ${req.capability}@${req.version}, but the capability has no active provider`,
          );
        }
      }
    }

    if (manifest.requires.plugins) {
      for (const reqPluginId of manifest.requires.plugins) {
        const loaded = this.plugins.get(reqPluginId);
        if (!loaded || (loaded.status !== "loaded" && loaded.status !== "enabled")) {
          throw new PluginDependencyError(
            `Plugin "${manifest.id}" requires missing or inactive plugin "${reqPluginId}"`,
          );
        }
      }
    }
  }

  public async load(input: PluginManifestInput): Promise<LoadedPlugin> {
    const hostEntry = this.authorizedEntry(input);
    const manifest = hostEntry.manifest;
    const pluginId = manifest.id;
    const hostTrustLevel = hostEntry.trustLevel;

    // 1. Validate manifest
    this.validateManifest(manifest);

    if (this.plugins.has(pluginId)) {
      throw new PluginLifecycleError(
        `Plugin "${pluginId}" is already loaded; unload it before loading again`,
      );
    }
    if (this.loadingPluginIds.has(pluginId)) {
      throw new PluginLifecycleError(`Plugin "${pluginId}" is already loading`);
    }

    // 2. Check dependencies
    this.checkDependencies(manifest);
    const registeredCapabilities: string[] = [];
    const createdCapabilities: string[] = [];
    const previousProviders = new Map<
      string,
      { checkpoint: ProviderRegistrationCheckpoint; wasActive: boolean }
    >();
    this.loadingPluginIds.add(pluginId);

    // 3. Register as provider in CapabilityRegistry for each capability
    try {
      for (const provision of manifest.provides) {
        let capability = this.registry.getCapability(provision.capability);
        if (!capability) {
          if (hostTrustLevel === "core" || hostTrustLevel === "official") {
            const newCap: Capability = {
              id: provision.capability,
              apiVersion: provision.apiVersion,
              replaceable: true,
              dependencies: [],
              metadata: {
                description: `Provided by ${pluginId}`,
                tags: [provision.capability.split(".")[0] ?? "plugin"],
              },
            };
            this.registry.registerCapability(newCap);
            createdCapabilities.push(provision.capability);
            capability = newCap;
          } else {
            throw new PluginDependencyError(
              `Capability "${provision.capability}" is not registered in CapabilityRegistry. Register capability before loading plugin.`,
            );
          }
        }

        const provider: CapabilityProvider = {
          providerId: pluginId,
          providerVersion: manifest.version,
          capabilityId: provision.capability,
          capabilityApiVersion: provision.apiVersion,
          trustLevel: hostTrustLevel,
          permissions: manifest.permissions.required,
          implementation: provision.implementation!,
          registeredAt: new Date(),
          metadata: {
            author: manifest.author,
            description: manifest.description,
          },
        };

        const previous = !previousProviders.has(provision.capability)
          ? this.registry.captureProviderRegistration(
              provision.capability,
              pluginId,
              HOST_CAPABILITY_REGISTRATION_AUTHORITY,
            )
          : undefined;
        const wasActive = previous
          ? this.registry.getActiveProvider(provision.capability)?.providerId === pluginId
          : false;
        this.registry.registerProvider(provider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
        if (previous)
          previousProviders.set(provision.capability, { checkpoint: previous, wasActive });
        registeredCapabilities.push(provision.capability);

        // If active provider is core or not set, bind it
        const active = this.registry.getActiveProvider(provision.capability);
        if (!active || active.providerId === "@modus/core" || hostTrustLevel === "core") {
          try {
            this.registry.activateProvider(provision.capability, pluginId);
          } catch {
            // Ignore if cannot activate immediately
          }
        }
      }

      // 4. Run lifecycle hook: onLoad
      if (manifest.lifecycle?.onLoad) {
        try {
          await manifest.lifecycle.onLoad();
        } catch (err) {
          throw new PluginLifecycleError(
            `Plugin "${pluginId}" onLoad lifecycle hook failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (manifest.id !== pluginId) {
        throw new PluginLifecycleError(
          `Plugin "${pluginId}" manifest identity changed during load`,
        );
      }

      const publicState: { status: PluginStatus; error?: string | undefined } = {
        status: "loaded",
      };
      const loadedPlugin: InternalLoadedPlugin = {
        manifest,
        get status() {
          return publicState.status;
        },
        set status(status: PluginStatus) {
          publicState.status = status;
        },
        get error() {
          return publicState.error;
        },
        set error(error: string | undefined) {
          publicState.error = error;
        },
        loadedAt: new Date(),
        publicState,
      };

      this.plugins.set(pluginId, loadedPlugin);
      return this.publicLoadedPlugin(loadedPlugin);
    } catch (error) {
      for (const capabilityId of registeredCapabilities) {
        try {
          this.registry.forceUnregisterProvider(
            capabilityId,
            pluginId,
            HOST_CAPABILITY_REGISTRATION_AUTHORITY,
          );
        } catch {
          // Continue rollback so one provider cannot prevent cleanup of the rest.
        }
      }
      for (const [capabilityId, previous] of previousProviders) {
        try {
          this.registry.restoreProviderRegistration(
            previous.checkpoint,
            HOST_CAPABILITY_REGISTRATION_AUTHORITY,
          );
          if (previous.wasActive && !this.registry.isProviderQuarantined(pluginId)) {
            try {
              this.registry.activateProvider(capabilityId, pluginId);
            } catch {
              /* non-replaceable or unavailable */
            }
          }
        } catch {
          // Preserve the load failure and continue restoring remaining providers.
        }
      }
      for (const capabilityId of createdCapabilities) {
        try {
          this.registry.removeCapabilityIfUnprovided(
            capabilityId,
            HOST_CAPABILITY_REGISTRATION_AUTHORITY,
          );
        } catch {
          // Preserve the load failure and attempt removal of every created capability.
        }
      }
      throw error;
    } finally {
      this.loadingPluginIds.delete(pluginId);
    }
  }

  public async enable(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new PluginLifecycleError(`Plugin "${pluginId}" is not loaded`);
    }

    if (this.registry.isProviderQuarantined(pluginId)) {
      throw new PluginLifecycleError(
        `Plugin "${pluginId}" is quarantined and requires host lifecycle recovery`,
      );
    }

    this.reserveLifecycle(pluginId, "enabling");
    try {
      await this.enablePlugin(plugin);
      this.activatePluginProviders(plugin);
    } finally {
      this.releaseLifecycle(pluginId);
    }
  }

  /** Host lifecycle hook runner. Quarantine recovery belongs to PluginLifecycleService. */
  public async enableFromHostLifecycle(input: PluginManifestInput): Promise<void> {
    const hostEntry = this.authorizedEntry(input);
    const manifest = hostEntry.manifest;
    const pluginId = manifest.id;
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.manifest !== manifest) {
      throw new PluginLifecycleError(
        `Plugin "${pluginId}@${manifest.version}" is not loaded from the exact host manifest`,
      );
    }

    this.reserveLifecycle(pluginId, "enabling");
    try {
      await this.enablePlugin(plugin);
    } finally {
      this.releaseLifecycle(pluginId);
    }
  }

  private async enablePlugin(plugin: InternalLoadedPlugin): Promise<void> {
    const pluginId = plugin.manifest.id;

    if (plugin.status === "enabled" && !this.registry.isProviderQuarantined(pluginId)) return;

    if (plugin.manifest.lifecycle?.onEnable) {
      try {
        await plugin.manifest.lifecycle.onEnable();
      } catch (err) {
        plugin.status = "error";
        plugin.error = err instanceof Error ? err.message : String(err);
        throw new PluginLifecycleError(`Failed to enable plugin "${pluginId}": ${plugin.error}`);
      }
    }

    plugin.status = "enabled";
  }

  private activatePluginProviders(plugin: InternalLoadedPlugin): void {
    for (const provision of plugin.manifest.provides) {
      try {
        this.registry.activateProvider(provision.capability, plugin.manifest.id);
      } catch {
        // Ignored if non-replaceable
      }
    }
  }

  public async disable(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new PluginLifecycleError(`Plugin "${pluginId}" is not loaded`);
    }

    this.reserveLifecycle(pluginId, "disabling");
    try {
      await this.disablePlugin(pluginId, plugin);
    } finally {
      this.releaseLifecycle(pluginId);
    }
  }

  /** Host safety gate that removes dispatch without running plugin callbacks. */
  public disableForHostSafety(pluginId: string): void {
    this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.status === "disabled") return;

    this.reserveLifecycle(pluginId, "safety disabling");
    try {
      for (const provision of plugin.manifest.provides) {
        this.registry.deactivateProvider(provision.capability, pluginId);
      }
      plugin.status = "disabled";
    } finally {
      this.releaseLifecycle(pluginId);
    }
  }

  private async disablePlugin(pluginId: string, plugin: InternalLoadedPlugin): Promise<void> {
    if (plugin.status === "disabled") return;

    if (plugin.manifest.lifecycle?.onDisable) {
      try {
        await plugin.manifest.lifecycle.onDisable();
      } catch (err) {
        throw new PluginLifecycleError(
          `Failed to disable plugin "${pluginId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // A disabled plugin must stop serving: step its providers down while
    // keeping their registrations, so enable() can reactivate them later.
    for (const provision of plugin.manifest.provides) {
      this.registry.deactivateProvider(provision.capability, pluginId);
    }

    plugin.status = "disabled";
  }

  public async unload(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;

    this.reserveLifecycle(pluginId, "unloading");
    try {
      // Quarantine before invoking plugin cleanup. A failing hook must never
      // leave the old implementation available for dispatch.
      this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      if (plugin.status === "enabled") {
        await this.disablePlugin(pluginId, plugin);
      }

      // Unloading removes the providers from dispatch entirely: executing the
      // capability afterwards falls back to remaining providers, or fails
      // closed with NoProviderError when none is left.
      for (const provision of plugin.manifest.provides) {
        this.registry.unregisterProvider(provision.capability, pluginId);
      }

      if (plugin.manifest.lifecycle?.onUnload) {
        try {
          await plugin.manifest.lifecycle.onUnload();
        } catch (err) {
          throw new PluginLifecycleError(
            `Plugin "${pluginId}" onUnload hook failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      plugin.status = "unloaded";
      this.plugins.delete(pluginId);
    } finally {
      this.releaseLifecycle(pluginId);
    }
  }

  private publicLoadedPlugin(plugin: InternalLoadedPlugin): LoadedPlugin {
    const existing = this.publicViews.get(plugin);
    if (existing) return existing;
    const state = plugin.publicState ?? { status: plugin.status, error: plugin.error };
    const loadedAt = new Date(plugin.loadedAt.getTime());
    const view = Object.freeze({
      manifest: this.publicManifest(plugin.manifest),
      get status() {
        return state.status;
      },
      get loadedAt() {
        return new Date(loadedAt.getTime());
      },
      get error() {
        return state.error;
      },
    }) as LoadedPlugin;
    this.publicViews.set(plugin, view);
    return view;
  }

  public getPlugin(pluginId: string): LoadedPlugin | undefined {
    const plugin = this.plugins.get(pluginId);
    return plugin ? this.publicLoadedPlugin(plugin) : undefined;
  }

  public listPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values(), (plugin) => this.publicLoadedPlugin(plugin));
  }

  public clear(): void {
    if (
      this.plugins.size > 0 ||
      this.loadingPluginIds.size > 0 ||
      this.lifecycleOperations.size > 0
    ) {
      throw new PluginLifecycleError(
        "Cannot clear plugin loader state while plugins are loaded or lifecycle work is in flight",
      );
    }
    this.plugins.clear();
  }
}
