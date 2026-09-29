import { installAdaptiveOracleBridge } from "./harness/adaptive-oracle-bridge";
import { PiSdkRuntime } from "./pi-sdk-runtime";
import type { AgentRuntime } from "./runtime";

// Gap 5: install Oracle findings bridge before constructing the singleton.
installAdaptiveOracleBridge(PiSdkRuntime);

const runtime = new PiSdkRuntime();

export function getAgentRuntime(): AgentRuntime {
  return runtime;
}
