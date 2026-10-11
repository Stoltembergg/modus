import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from "../src/main/agent/harness/capability/capability-registration-authority";
import type { CapabilityRegistry } from "../src/main/agent/harness/capability/capability-registry";

type CapabilityDefinition = Parameters<CapabilityRegistry["registerCapability"]>[0];

export function registerTestCapability(
  registry: CapabilityRegistry,
  capability: CapabilityDefinition,
): void {
  registry.registerCapability(capability, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
}
