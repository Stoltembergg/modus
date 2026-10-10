import type { HarnessContext } from "../../kernel/harness-hooks";
import type { PromptSectionProvider } from "../prompt-section";

export class MemorySectionProvider implements PromptSectionProvider {
  getSectionId(): string {
    return "memory";
  }

  getPriority(): number {
    return 400;
  }

  isVolatile(): boolean {
    return true; // Changes per turn based on session hints and working memory
  }

  buildContent(context: HarnessContext): string {
    const memoryHints =
      (context.state.get("memoryHints") as Array<{ text: string; scope?: string }>) ?? [];
    if (memoryHints.length === 0) {
      return "";
    }

    const items = memoryHints.map((h) => `- ${h.text}${h.scope ? ` (${h.scope})` : ""}`).join("\n");
    return `<project_memory>\n${items}\n</project_memory>`;
  }
}
