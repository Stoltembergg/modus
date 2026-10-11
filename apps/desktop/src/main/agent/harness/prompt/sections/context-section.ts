import type { HarnessContext } from "../../kernel/harness-hooks";
import type { PromptSectionProvider } from "../prompt-section";

export class ContextSectionProvider implements PromptSectionProvider {
  getSectionId(): string {
    return "context";
  }

  getPriority(): number {
    return 500;
  }

  isVolatile(): boolean {
    return true; // Dynamic per-turn context (active files, selection, git branch)
  }

  buildContent(context: HarnessContext): string {
    const activeFiles = (context.state.get("activeFiles") as string[]) ?? [];
    const branch = (context.state.get("branch") as string) ?? "";
    const parts: string[] = [];

    if (branch) {
      parts.push(`Current Git Branch: ${branch}`);
    }
    if (activeFiles.length > 0) {
      parts.push("Active Workspace Files:\n" + activeFiles.map((f) => `- ${f}`).join("\n"));
    }

    if (parts.length === 0) {
      return "";
    }

    return `<session_context>\n${parts.join("\n\n")}\n</session_context>`;
  }
}
