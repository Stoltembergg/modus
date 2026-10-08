/**
 * @file capability-discovery.ts
 * Discovery API and CLI presentation layer for Capabilities and Providers (Fase 9.3).
 */

import type { CapabilityRegistry } from './capability-registry';
import type { DiscoveredCapability } from './capability-types';

export interface CapabilitiesDiscoveryOutput {
  capabilities: DiscoveredCapability[];
}

export interface SwitchProviderResult {
  capabilityId: string;
  previousProvider: string;
  newProvider: string;
  trustLevel: string;
  version: string;
  message: string;
}

export class CapabilityDiscovery {
  constructor(private registry: CapabilityRegistry) {}

  public listJson(): CapabilitiesDiscoveryOutput {
    return {
      capabilities: this.registry.listDiscoveredCapabilities(),
    };
  }

  public formatTable(): string {
    const list = this.registry.listDiscoveredCapabilities();
    const headers = [
      'CAPABILITY',
      'API VER',
      'REPLACEABLE',
      'ACTIVE PROVIDER',
      'TRUST',
      'ALTERNATIVES',
    ];

    const rows = list.map((item) => {
      const activeStr = item.activeProvider
        ? `${item.activeProvider.id}@${item.activeProvider.version}`
        : '(none)';
      const trustStr = item.activeProvider ? item.activeProvider.trustLevel : '-';
      const altStr =
        item.alternativeProviders.length > 0
          ? item.alternativeProviders.map((a) => `${a.id}@${a.version}`).join(', ')
          : '(none)';
      const replStr = item.replaceable ? 'yes' : 'no (core)';

      return [
        item.id,
        item.apiVersion,
        replStr,
        activeStr,
        trustStr,
        altStr,
      ];
    });

    const colWidths = headers.map((h, i) => {
      const maxRow = rows.reduce((max, r) => Math.max(max, (r[i] ?? '').length), 0);
      return Math.max(h.length, maxRow);
    });

    const formatRow = (cols: string[]) =>
      cols.map((c, i) => c.padEnd(colWidths[i] ?? c.length)).join('  ');

    const separator = colWidths.map((w) => '-'.repeat(w)).join('  ');

    return [
      formatRow(headers),
      separator,
      ...rows.map((r) => formatRow(r)),
    ].join('\n');
  }

  public switch(capabilityId: string, targetProviderId: string): SwitchProviderResult {
    const switchOutcome = this.registry.switchProvider(capabilityId, targetProviderId);
    const active = this.registry.getActiveProvider(capabilityId);
    if (!active) {
      throw new Error(`Failed to verify active provider for ${capabilityId}`);
    }

    return {
      capabilityId,
      previousProvider: switchOutcome.from ?? '(none)',
      newProvider: active.providerId,
      trustLevel: active.trustLevel,
      version: active.providerVersion,
      message: `Switching ${capabilityId} provider: ${switchOutcome.from ?? '(none)'} -> ${active.providerId}@${active.providerVersion} (${active.trustLevel})`,
    };
  }
}
