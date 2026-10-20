import { validateFeatureFlags } from "./harness/feature-flags";
import { PiSdkRuntime } from "./pi-sdk-runtime";
import type { AgentRuntime } from "./runtime";

const featureFlagErrors = validateFeatureFlags();
if (featureFlagErrors.length > 0) {
  console.warn(
    `[modus] Invalid Harness feature flag configuration; dependent features are disabled: ${featureFlagErrors.join("; ")}`,
  );
}

const runtime = new PiSdkRuntime();

export function getAgentRuntime(): AgentRuntime {
  return runtime;
}

export async function shutdownAgentRuntime(): Promise<void> {
  await runtime.shutdown();
}
