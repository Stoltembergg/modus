import { isFeatureFlagEnabled } from "../../feature-flags";
import type { HarnessContext } from "../../kernel/harness-hooks";
import {
  DEFAULT_RESPONSE_LEVEL,
  RESPONSE_POLICY_PROMPTS,
  type ResponseLevel,
} from "../../response/response-policy";
import type { PromptSectionProvider } from "../prompt-section";

export class PolicySectionProvider implements PromptSectionProvider {
  getSectionId(): string {
    return "policy";
  }

  getPriority(): number {
    return 350;
  }

  isVolatile(): boolean {
    return false;
  }

  buildContent(context: HarnessContext): string {
    const policy = (context.state.get("responsePolicy") as string) ?? "standard";

    if (isFeatureFlagEnabled("MODUS_RESPONSE_POLICY")) {
      const level = (
        policy in RESPONSE_POLICY_PROMPTS ? policy : DEFAULT_RESPONSE_LEVEL
      ) as ResponseLevel;
      return RESPONSE_POLICY_PROMPTS[level];
    }

    return `Response Policy: ${policy}. Be direct, cite file paths explicitly with clickable markdown links, and avoid repeating full file contents unnecessarily.`;
  }
}
