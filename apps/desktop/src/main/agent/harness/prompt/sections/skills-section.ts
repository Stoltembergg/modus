import type { HarnessContext } from "../../kernel/harness-hooks";
import type { PromptSectionProvider } from "../prompt-section";

export class SkillsSectionProvider implements PromptSectionProvider {
  getSectionId(): string {
    return "skills";
  }

  getPriority(): number {
    return 300;
  }

  isVolatile(): boolean {
    return false;
  }

  buildContent(context: HarnessContext): string {
    const activeTools = (context.state.get("activeTools") as string[]) ?? [
      "read",
      "edit",
      "terminal_run",
      "terminal_read",
      "grep",
      "find",
      "todo",
    ];

    return [
      "Available Capabilities & Tools:",
      ...activeTools.map((tool) => `- ${tool}`),
    ].join("\n");
  }
}
