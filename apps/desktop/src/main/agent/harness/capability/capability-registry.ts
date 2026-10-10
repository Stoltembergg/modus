/**
 * @file capability-registry.ts
 * Core Capability Registry with multi-provider support, version decoupling, and provenance tracking.
 */

import { randomUUID } from "crypto";
import type { PluginInstrumentation } from "../plugin/plugin-instrumentation";
import { ProvenanceTracker } from "./capability-provenance";
import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from "./capability-registration-authority";
import type {
  Capability,
  CapabilityProvenance,
  CapabilityProvider,
  CapabilityProviderDescriptor,
  DiscoveredCapability,
  ProviderRegistrationCheckpoint,
} from "./capability-types";
import {
  CapabilityConflictError,
  IncompatibleApiVersionError,
  NoProviderError,
} from "./capability-types";

export class CapabilityRegistry {
  private capabilities = new Map<string, Capability>();
  private providers = new Map<string, CapabilityProvider[]>();
  private activeProviders = new Map<string, string>();
  private quarantinedProviderIds = new Set<string>();
  private implementationSources = new WeakMap<CapabilityProvider, object>();
  private implementationExecutors = new WeakMap<
    CapabilityProvider,
    CapabilityProvider["implementation"]["execute"]
  >();
  private providerRegistrationCheckpoints = new WeakMap<
    ProviderRegistrationCheckpoint,
    CapabilityProvider
  >();
  private tracker = new ProvenanceTracker();
  private instrumentation?: PluginInstrumentation | undefined;

  private cloneCapability(capability: Capability): Capability {
    return {
      ...capability,
      dependencies: [...capability.dependencies],
      metadata: {
        ...capability.metadata,
        ...(capability.metadata.tags ? { tags: [...capability.metadata.tags] } : {}),
      },
    };
  }

  private cloneProvider(provider: CapabilityProvider): CapabilityProvider {
    const sourceImplementation =
      this.implementationSources.get(provider) ?? provider.implementation;
    // Capture once at registration, and invoke unbound: providers must use closures
    // for state, never rely on the source object's receiver or later property changes.
    const execute = this.implementationExecutors.get(provider) ?? provider.implementation.execute;
    const implementation = Object.freeze({
      execute: (context: unknown, signal?: AbortSignal) => execute.call(undefined, context, signal),
    });
    const cloned: CapabilityProvider = {
      ...provider,
      implementation,
      permissions: structuredClone(provider.permissions),
      registeredAt: new Date(provider.registeredAt.getTime()),
      metadata: structuredClone(provider.metadata),
    };
    this.implementationSources.set(cloned, sourceImplementation);
    this.implementationExecutors.set(cloned, execute);
    return cloned;
  }

  private immutableSnapshot<T>(value: T): T {
    if (value instanceof Date) return new Date(value.getTime()) as T;
    if (Array.isArray(value)) {
      return Object.freeze(
        value
          .filter((item) => typeof item !== "function")
          .map((item) => this.immutableSnapshot(item)),
      ) as T;
    }
    if (value && typeof value === "object") {
      const snapshot = Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => typeof item !== "function")
          .map(([key, item]) => [key, this.immutableSnapshot(item)]),
      );
      return Object.freeze(snapshot) as T;
    }
    return value;
  }

  private providerDescriptor(provider: CapabilityProvider): CapabilityProviderDescriptor {
    const metadata: CapabilityProviderDescriptor = {
      providerId: provider.providerId,
      providerVersion: provider.providerVersion,
      capabilityId: provider.capabilityId,
      capabilityApiVersion: provider.capabilityApiVersion,
      trustLevel: provider.trustLevel,
      permissions: provider.permissions,
      registeredAt: provider.registeredAt,
      metadata: provider.metadata,
    };
    return this.immutableSnapshot(metadata) as CapabilityProviderDescriptor;
  }

  // ---------------------------------------------------------------------------
  // Capability Management
  // ---------------------------------------------------------------------------

  public registerCapability(capability: Capability): void {
    const existing = this.capabilities.get(capability.id);
    if (existing) {
      if (existing.apiVersion !== capability.apiVersion) {
        throw new CapabilityConflictError(
          `Capability "${capability.id}" already registered with version ${existing.apiVersion}, cannot overwrite with ${capability.apiVersion}`,
        );
      }
      return;
    }
    this.capabilities.set(capability.id, this.cloneCapability(capability));
  }

  /** Host-only rollback for a capability created by an unsuccessful registration transaction. */
  public removeCapabilityIfUnprovided(capabilityId: string, authority?: symbol): boolean {
    if (authority !== HOST_CAPABILITY_REGISTRATION_AUTHORITY) {
      throw new CapabilityConflictError("Capability rollback is reserved for the host.");
    }
    if ((this.providers.get(capabilityId) ?? []).length > 0) return false;
    this.capabilities.delete(capabilityId);
    this.activeProviders.delete(capabilityId);
    return true;
  }

  public getCapability(capabilityId: string): Capability | undefined {
    const capability = this.capabilities.get(capabilityId);
    return capability ? this.immutableSnapshot(capability) : undefined;
  }

  public listCapabilities(): Capability[] {
    return Object.freeze(
      Array.from(this.capabilities.values(), (capability) => this.immutableSnapshot(capability)),
    ) as unknown as Capability[];
  }

  // ---------------------------------------------------------------------------
  // Provider Management
  // ---------------------------------------------------------------------------

  public registerProvider(provider: CapabilityProvider, authority?: symbol): void {
    if (authority !== HOST_CAPABILITY_REGISTRATION_AUTHORITY) {
      throw new CapabilityConflictError(
        `Provider registration for capability "${provider.capabilityId}" is reserved for the host.`,
      );
    }
    const capability = this.capabilities.get(provider.capabilityId);
    if (!capability) {
      throw new NoProviderError(
        `Cannot register provider for unknown capability "${provider.capabilityId}"`,
      );
    }

    if (capability.apiVersion !== provider.capabilityApiVersion) {
      throw new IncompatibleApiVersionError(
        provider.capabilityId,
        capability.apiVersion,
        provider.capabilityApiVersion,
      );
    }

    const list = this.providers.get(provider.capabilityId) ?? [];
    if (
      !capability.replaceable &&
      list.length > 0 &&
      !list.some((p) => p.providerId === provider.providerId)
    ) {
      throw new CapabilityConflictError(
        `Capability "${provider.capabilityId}" is marked non-replaceable. Additional providers cannot be registered.`,
      );
    }

    const existingIndex = list.findIndex((p) => p.providerId === provider.providerId);
    if (existingIndex >= 0) {
      if (
        !capability.replaceable &&
        this.implementationSources.get(list[existingIndex]!) !== provider.implementation
      ) {
        throw new CapabilityConflictError(
          `Capability "${provider.capabilityId}" is marked non-replaceable. Provider "${provider.providerId}" cannot be replaced.`,
        );
      }
      list[existingIndex] = this.cloneProvider(provider);
    } else {
      list.push(this.cloneProvider(provider));
    }
    this.providers.set(provider.capabilityId, list);

    // Auto-activate if no active provider yet
    if (!this.activeProviders.has(provider.capabilityId)) {
      this.activeProviders.set(provider.capabilityId, provider.providerId);
    }
  }

  public getActiveProvider(capabilityId: string): CapabilityProviderDescriptor | undefined {
    const activeId = this.activeProviders.get(capabilityId);
    if (!activeId) return undefined;
    const list = this.providers.get(capabilityId) ?? [];
    const provider = this.quarantinedProviderIds.has(activeId)
      ? list.find((p) => !this.quarantinedProviderIds.has(p.providerId))
      : list.find((p) => p.providerId === activeId);
    return provider ? this.providerDescriptor(provider) : undefined;
  }

  public listProviders(capabilityId: string): CapabilityProviderDescriptor[] {
    return Object.freeze(
      (this.providers.get(capabilityId) ?? [])
        .filter((provider) => !this.quarantinedProviderIds.has(provider.providerId))
        .map((provider) => this.providerDescriptor(provider)),
    ) as CapabilityProviderDescriptor[];
  }

  /** Capture private rollback state behind a non-executable, registry-owned handle. */
  public captureProviderRegistration(
    capabilityId: string,
    providerId: string,
    authority?: symbol,
  ): ProviderRegistrationCheckpoint | undefined {
    if (authority !== HOST_CAPABILITY_REGISTRATION_AUTHORITY) {
      throw new CapabilityConflictError("Provider registration capture is reserved for the host.");
    }
    const provider = (this.providers.get(capabilityId) ?? []).find(
      (item) => item.providerId === providerId,
    );
    if (!provider) return undefined;
    const checkpoint = Object.freeze({}) as ProviderRegistrationCheckpoint;
    this.providerRegistrationCheckpoints.set(checkpoint, this.cloneProvider(provider));
    return checkpoint;
  }

  /** Restore a provider captured by this registry without returning its code to the caller. */
  public restoreProviderRegistration(
    checkpoint: ProviderRegistrationCheckpoint,
    authority?: symbol,
  ): boolean {
    if (authority !== HOST_CAPABILITY_REGISTRATION_AUTHORITY) {
      throw new CapabilityConflictError("Provider registration restore is reserved for the host.");
    }
    const provider = this.providerRegistrationCheckpoints.get(checkpoint);
    if (!provider) return false;
    this.registerProvider(provider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
    this.providerRegistrationCheckpoints.delete(checkpoint);
    return true;
  }

  public quarantineProvider(providerId: string, authority?: symbol): void {
    if (authority !== HOST_CAPABILITY_REGISTRATION_AUTHORITY)
      throw new CapabilityConflictError("Provider quarantine is reserved for the host.");
    this.quarantinedProviderIds.add(providerId);
    for (const [capabilityId, activeId] of this.activeProviders) {
      if (activeId !== providerId) continue;
      const fallback = (this.providers.get(capabilityId) ?? []).find(
        (provider) => !this.quarantinedProviderIds.has(provider.providerId),
      );
      if (fallback) this.activeProviders.set(capabilityId, fallback.providerId);
      else this.activeProviders.delete(capabilityId);
    }
  }

  public clearProviderQuarantine(providerId: string, authority?: symbol): void {
    if (authority !== HOST_CAPABILITY_REGISTRATION_AUTHORITY)
      throw new CapabilityConflictError("Provider quarantine recovery is reserved for the host.");
    this.quarantinedProviderIds.delete(providerId);
  }

  public isProviderQuarantined(providerId: string): boolean {
    return this.quarantinedProviderIds.has(providerId);
  }

  /**
   * Removes a provider. If it was the active one, the first remaining
   * provider takes over; with none left the capability stays registered but
   * undispatched (execute throws NoProviderError — fail-closed).
   * The last provider of a non-replaceable capability cannot be removed:
   * core invariants must always stay dispatchable.
   */
  public unregisterProvider(capabilityId: string, providerId: string): boolean {
    const capability = this.capabilities.get(capabilityId);
    const list = this.providers.get(capabilityId) ?? [];
    const index = list.findIndex((p) => p.providerId === providerId);
    if (index < 0) return false;

    if (capability && !capability.replaceable && list.length === 1) {
      throw new CapabilityConflictError(
        `Capability "${capabilityId}" is marked non-replaceable. Its last provider "${providerId}" cannot be removed.`,
      );
    }

    list.splice(index, 1);
    if (list.length === 0) {
      this.providers.delete(capabilityId);
    } else {
      this.providers.set(capabilityId, list);
    }

    if (this.activeProviders.get(capabilityId) === providerId) {
      const fallback = list[0];
      if (fallback) {
        this.activeProviders.set(capabilityId, fallback.providerId);
      } else {
        this.activeProviders.delete(capabilityId);
      }
    }
    return true;
  }

  /** Host-only force removal used to roll back partial provider registrations. */
  public forceUnregisterProvider(
    capabilityId: string,
    providerId: string,
    authority?: symbol,
  ): boolean {
    if (authority !== HOST_CAPABILITY_REGISTRATION_AUTHORITY) {
      throw new CapabilityConflictError("Forced provider removal is reserved for the host.");
    }
    const list = this.providers.get(capabilityId) ?? [];
    const index = list.findIndex((provider) => provider.providerId === providerId);
    if (index < 0) return false;
    list.splice(index, 1);
    if (list.length === 0) this.providers.delete(capabilityId);
    else this.providers.set(capabilityId, list);
    if (this.activeProviders.get(capabilityId) === providerId) {
      const fallback = list.find(
        (provider) => !this.quarantinedProviderIds.has(provider.providerId),
      );
      if (fallback) this.activeProviders.set(capabilityId, fallback.providerId);
      else this.activeProviders.delete(capabilityId);
    }
    return true;
  }

  /**
   * Steps a provider down without removing its registration (standby).
   * Falls back to the first remaining provider, or clears the active slot
   * when none is left. Returns false when the provider was not active.
   */
  public deactivateProvider(capabilityId: string, providerId: string): boolean {
    if (this.activeProviders.get(capabilityId) !== providerId) return false;
    const list = this.providers.get(capabilityId) ?? [];
    const fallback = list.find((p) => p.providerId !== providerId);
    if (fallback) {
      this.activeProviders.set(capabilityId, fallback.providerId);
    } else {
      this.activeProviders.delete(capabilityId);
    }
    return true;
  }

  public activateProvider(capabilityId: string, providerId: string): void {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      throw new NoProviderError(`Unknown capability "${capabilityId}"`);
    }

    // Non-replaceable capabilities cannot change their active provider once
    // one is set (initial activation and idempotent re-activation stay allowed).
    // Checked before target lookup, mirroring switchProvider.
    const currentActive = this.activeProviders.get(capabilityId);
    if (!capability.replaceable && currentActive !== undefined && currentActive !== providerId) {
      throw new CapabilityConflictError(
        `Capability "${capabilityId}" is marked non-replaceable. Active provider cannot be changed from "${currentActive}".`,
      );
    }

    const list = this.providers.get(capabilityId) ?? [];
    if (this.quarantinedProviderIds.has(providerId))
      throw new CapabilityConflictError(`Provider "${providerId}" is quarantined.`);
    const target = list.find((p) => p.providerId === providerId);
    if (!target) {
      throw new NoProviderError(
        `Provider "${providerId}" is not registered for capability "${capabilityId}"`,
      );
    }
    this.activeProviders.set(capabilityId, providerId);
  }

  public switchProvider(
    capabilityId: string,
    targetProviderId: string,
  ): { from?: string | undefined; to: string } {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      throw new NoProviderError(`Unknown capability "${capabilityId}"`);
    }

    if (!capability.replaceable) {
      throw new CapabilityConflictError(
        `Capability "${capabilityId}" is marked non-replaceable. Active provider cannot be changed.`,
      );
    }

    const list = this.providers.get(capabilityId) ?? [];
    if (this.quarantinedProviderIds.has(targetProviderId))
      throw new CapabilityConflictError(`Provider "${targetProviderId}" is quarantined.`);
    const target = list.find((p) => p.providerId === targetProviderId);
    if (!target) {
      throw new NoProviderError(
        `Provider "${targetProviderId}" is not registered for capability "${capabilityId}"`,
      );
    }

    const from = this.activeProviders.get(capabilityId);
    this.activeProviders.set(capabilityId, targetProviderId);

    return { from, to: targetProviderId };
  }

  // ---------------------------------------------------------------------------
  // Instrumentation & Observability Integration (Fase 12)
  // ---------------------------------------------------------------------------

  public setInstrumentation(instrumentation: PluginInstrumentation): void {
    this.instrumentation = instrumentation;
  }

  public getInstrumentation(): PluginInstrumentation | undefined {
    return this.instrumentation;
  }

  // ---------------------------------------------------------------------------
  // Execution Dispatcher & Provenance
  // ---------------------------------------------------------------------------

  public async execute<TContext = unknown, TResult = unknown>(
    capabilityId: string,
    context: TContext,
    signal?: AbortSignal,
  ): Promise<TResult> {
    const capability = this.capabilities.get(capabilityId);
    const activeId = this.activeProviders.get(capabilityId);
    const activeProvider = (this.providers.get(capabilityId) ?? []).find(
      (provider) => provider.providerId === activeId,
    );

    if (
      !capability ||
      !activeProvider ||
      this.quarantinedProviderIds.has(activeProvider.providerId)
    ) {
      throw new NoProviderError(capabilityId);
    }

    const runner = async (executionSignal?: AbortSignal): Promise<TResult> => {
      const traceId = randomUUID();
      this.tracker.recordStart(
        traceId,
        capabilityId,
        capability.apiVersion,
        activeProvider.providerId,
        activeProvider.providerVersion,
      );

      const startTime = Date.now();
      try {
        const result = await activeProvider.implementation.execute(context, executionSignal);
        const durationMs = Date.now() - startTime;
        this.tracker.recordSuccess(traceId, capabilityId, activeProvider.providerId, durationMs);
        return result as TResult;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        this.tracker.recordFailure(
          traceId,
          capabilityId,
          activeProvider.providerId,
          durationMs,
          error,
        );
        throw error;
      }
    };

    if (this.instrumentation) {
      return await this.instrumentation.trace(activeProvider.providerId, capabilityId, runner, {
        version: activeProvider.providerVersion,
        ...(signal ? { signal } : {}),
      });
    }

    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Capability execution cancelled.");
    }
    return await runner(signal);
  }

  public getProvenance(capabilityId: string): CapabilityProvenance {
    const capability = this.capabilities.get(capabilityId);
    const active = this.getActiveProvider(capabilityId);
    if (!capability || !active) {
      throw new NoProviderError(capabilityId);
    }

    return this.tracker.getProvenance(
      capabilityId,
      capability.apiVersion,
      active,
      this.listProviders(capabilityId),
    );
  }

  public getAllProvenance(): CapabilityProvenance[] {
    const results: CapabilityProvenance[] = [];
    for (const [id, capability] of this.capabilities.entries()) {
      const active = this.getActiveProvider(id);
      if (active) {
        results.push(
          this.tracker.getProvenance(id, capability.apiVersion, active, this.listProviders(id)),
        );
      }
    }
    return results;
  }

  public listDiscoveredCapabilities(): DiscoveredCapability[] {
    return Array.from(this.capabilities.values()).map((cap) => {
      const active = this.getActiveProvider(cap.id);
      const all = this.listProviders(cap.id);
      const alternatives = all
        .filter((p) => p.providerId !== active?.providerId)
        .map((p) => ({
          id: p.providerId,
          version: p.providerVersion,
          trustLevel: p.trustLevel,
        }));

      return {
        id: cap.id,
        apiVersion: cap.apiVersion,
        replaceable: cap.replaceable,
        activeProvider: active
          ? {
              id: active.providerId,
              version: active.providerVersion,
              trustLevel: active.trustLevel,
            }
          : undefined,
        alternativeProviders: alternatives,
      };
    });
  }

  public getTraces(capabilityId?: string, limit?: number) {
    return this.tracker.getTraces(capabilityId, limit);
  }

  public clear(): void {
    this.capabilities.clear();
    this.providers.clear();
    this.activeProviders.clear();
    this.quarantinedProviderIds.clear();
    this.implementationSources = new WeakMap();
    this.implementationExecutors = new WeakMap();
    this.providerRegistrationCheckpoints = new WeakMap();
    this.tracker.clear();
  }
}

let defaultRegistry: CapabilityRegistry | null = null;

export function getCapabilityRegistry(): CapabilityRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new CapabilityRegistry();
  }
  return defaultRegistry;
}

export function resetCapabilityRegistry(): void {
  defaultRegistry = null;
}
