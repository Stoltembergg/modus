/**
 * Modus Harness Evolution — Fase 9: Capability Registry + Provenance Architecture
 * Defines core contracts for capabilities, decoupled providers, permissions,
 * execution traces, and provenance records.
 */

export type TrustLevel = "core" | "official" | "verified" | "community" | "local";

export interface PluginPermissions {
  filesystem?:
    | {
        read?: string[];
        write?: string[];
      }
    | undefined;
  memory?:
    | {
        read?: boolean;
        write?: boolean;
      }
    | undefined;
  network?:
    | {
        domains?: string[];
        ports?: number[];
      }
    | undefined;
  tools?:
    | {
        allow?: string[];
        deny?: string[];
      }
    | undefined;
  resources?:
    | {
        maxMemoryMb?: number;
        timeoutMs?: number;
      }
    | undefined;
}

export interface Capability<TContext = unknown, TResult = unknown> {
  id: string; // e.g. "memory.retrieve", "agent.loop"
  apiVersion: string; // Semver format, e.g. "1.0"
  replaceable: boolean; // Core runtime essentials like agent.loop are false
  dependencies: string[]; // List of capability IDs required
  metadata: {
    description?: string | undefined;
    category?: string | undefined;
    stability?: "experimental" | "beta" | "stable" | "deprecated" | undefined;
    tags?: string[] | undefined;
  };
}

export interface CapabilityImplementation<TContext = unknown, TResult = unknown> {
  /** Implementations are receiver-independent; use closures for state rather than `this`. */
  execute(this: void, context: TContext, signal?: AbortSignal): Promise<TResult> | TResult;
}

export interface CapabilityProvider<TContext = unknown, TResult = unknown> {
  providerId: string; // e.g. "@modus/memory", "@community/vector-memory"
  providerVersion: string; // e.g. "2.7.3"
  capabilityId: string; // e.g. "memory.retrieve"
  capabilityApiVersion: string; // e.g. "1.0"
  trustLevel: TrustLevel;
  permissions: PluginPermissions;
  implementation: CapabilityImplementation<TContext, TResult>;
  registeredAt: Date;
  metadata: {
    author?: string | undefined;
    description?: string | undefined;
    homepage?: string | undefined;
    performance?:
      | {
          avgLatency?: number | undefined;
          maxLatency?: number | undefined;
        }
      | undefined;
  };
}

/** Public provider data omits executable code; invocation must go through the registry. */
export type CapabilityProviderDescriptor = Omit<CapabilityProvider, "implementation">;

declare const providerRegistrationCheckpointBrand: unique symbol;

/** Opaque rollback handle; the registered implementation remains private to CapabilityRegistry. */
export type ProviderRegistrationCheckpoint = {
  readonly [providerRegistrationCheckpointBrand]: "ProviderRegistrationCheckpoint";
};

export interface CapabilityExecutionTrace {
  traceId: string;
  capability: string;
  capabilityApiVersion: string;
  providerId: string;
  providerVersion: string;
  startTime: number;
  endTime?: number | undefined;
  durationMs?: number | undefined;
  success?: boolean | undefined;
  error?: string | undefined;
}

export interface CapabilityProvenance {
  capability: string;
  apiVersion: string;
  activeProvider: {
    id: string;
    version: string;
    trustLevel: TrustLevel;
  };
  alternativeProviders: Array<{
    id: string;
    version: string;
    trustLevel: TrustLevel;
  }>;
  usageCount: number;
  lastUsed?: Date | undefined;
  errorRate: number;
  avgLatencyMs?: number | undefined;
}

export interface DiscoveredCapability {
  id: string;
  apiVersion: string;
  replaceable: boolean;
  activeProvider?:
    | {
        id: string;
        version: string;
        trustLevel: TrustLevel;
      }
    | undefined;
  alternativeProviders: Array<{
    id: string;
    version: string;
    trustLevel: TrustLevel;
  }>;
}

export class NoProviderError extends Error {
  constructor(public readonly capabilityId: string) {
    super(`No active provider registered for capability "${capabilityId}"`);
    this.name = "NoProviderError";
  }
}

export class CapabilityUnavailableError extends Error {
  constructor(
    public readonly capabilityId: string,
    reason: string,
  ) {
    super(`Capability "${capabilityId}" is unavailable: ${reason}`);
    this.name = "CapabilityUnavailableError";
  }
}

export class CapabilityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityConflictError";
  }
}

export class IncompatibleApiVersionError extends Error {
  constructor(
    public readonly capabilityId: string,
    public readonly expectedVersion: string,
    public readonly providedVersion: string,
  ) {
    super(
      `Provider for capability "${capabilityId}" specifies API version "${providedVersion}" which is incompatible with capability version "${expectedVersion}"`,
    );
    this.name = "IncompatibleApiVersionError";
  }
}
