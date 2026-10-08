import { getFeatureFlags } from "../feature-flags";
import { DEFAULT_TOOL_RESULT_POLICY, TOOL_SPECIFIC_POLICIES } from "../tools/tool-result-policy";
import type {
  HarnessContext,
  HarnessHook,
  ToolsRegisterInput,
  ToolsRegisterOutput,
} from "./harness-hooks";

/**
 * Standard Tools Register Hook:
 * Filters available tools by user permissions and applies calibrated spill policies.
 * Uses 20 KB (~5,000 tokens) threshold as verified in Sprint 0.3 empirical analysis.
 */
export const toolsRegisterHook: HarnessHook<ToolsRegisterInput, ToolsRegisterOutput> = {
  name: "tools_register_policy",
  phase: "tools_register",
  priority: 10,
  isCritical: false,
  execute: async (
    input: ToolsRegisterInput,
    context: HarnessContext
  ): Promise<ToolsRegisterOutput> => {
    const rawTools: string[] = input.availableTools ?? input.requestedTools ?? [];
    const permissions: string[] = input.permissions ?? [];
    const permissionsSet = new Set(permissions);

    const baseEnabledTools: string[] =
      permissions.length > 0
        ? rawTools.filter((tool: string) => permissionsSet.has(tool))
        : rawTools;

    const flags = getFeatureFlags();
    const enabledTools = [...baseEnabledTools];

    // Expose retrieve_spilled_tool_result capability when spill flag is enabled
    if (flags.MODUS_TOOL_RESULT_SPILL && !enabledTools.includes("retrieve_spilled_tool_result")) {
      enabledTools.push("retrieve_spilled_tool_result");
    }

    const defaultSpillThreshold =
      input.activeSpillThresholdBytes ?? DEFAULT_TOOL_RESULT_POLICY.spillThresholdBytes;

    const spillPolicies: Record<string, { spillThresholdBytes?: number }> = {};
    for (const tool of enabledTools) {
      const toolOverride = TOOL_SPECIFIC_POLICIES[tool];
      spillPolicies[tool] = {
        spillThresholdBytes:
          input.activeSpillThresholdBytes ??
          toolOverride?.spillThresholdBytes ??
          defaultSpillThreshold,
      };
    }

    context.state.set("enabled_tools", enabledTools);
    context.state.set("spill_threshold_bytes", defaultSpillThreshold);
    context.state.set("spill_policies", spillPolicies);

    return {
      registeredTools: enabledTools,
      enabledTools,
      spillThresholdBytes: defaultSpillThreshold,
      spillPolicies,
    };
  },
};
