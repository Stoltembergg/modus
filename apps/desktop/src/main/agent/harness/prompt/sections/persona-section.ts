import type { HarnessContext } from "../../kernel/harness-hooks";
import type { PromptSectionProvider } from "../prompt-section";

export class PersonaSectionProvider implements PromptSectionProvider {
  getSectionId(): string {
    return "persona";
  }

  getPriority(): number {
    return 100;
  }

  isVolatile(): boolean {
    return false;
  }

  buildContent(context: HarnessContext): string {
    return [
      "You are Modus, an agentic AI software engineering partner.",
      "You work collaboratively with the user to plan, inspect, build, test, and verify code.",
      `Current mode: ${context.mode}. Workspace root: ${context.cwd}.`,
    ].join("\n");
  }
}
