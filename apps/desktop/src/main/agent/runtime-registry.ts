import { installAdaptiveOracleBridge } from "./harness/adaptive-oracle-bridge";
import { validateFeatureFlags } from "./harness/feature-flags";
import { PiSdkRuntime } from "./pi-sdk-runtime";
import type { AgentRuntime } from "./runtime";

const featureFlagErrors = validateFeatureFlags();
if (featureFlagErrors.length > 0) {
  console.warn(
    `[modus] Invalid Harness feature flag configuration; dependent features are disabled: ${featureFlagErrors.join("; ")}`,
  );
}

// Gap 5: install Oracle findings bridge before constructing the singleton.
installAdaptiveOracleBridge(PiSdkRuntime);

const runtime = new PiSdkRuntime();

export function getAgentRuntime(): AgentRuntime {
  return runtime;
}
