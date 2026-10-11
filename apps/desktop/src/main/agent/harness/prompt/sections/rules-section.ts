import type { HarnessContext } from "../../kernel/harness-hooks";
import type { PromptSectionProvider } from "../prompt-section";

export class RulesSectionProvider implements PromptSectionProvider {
  getSectionId(): string {
    return "rules";
  }

  getPriority(): number {
    return 200;
  }

  isVolatile(): boolean {
    return false;
  }

  buildContent(_context: HarnessContext): string {
    return [
      "Operational Rules:",
      "- Verify hypotheses by reading files or running targeted tests before editing.",
      "- Ground all task completion claims in actual test or verifier evidence.",
      "- Maintain non-destructive file edits and preserve unrelated existing code.",
      "- Respect user consent and security boundaries for destructive actions.",
    ].join("\n");
  }
}
