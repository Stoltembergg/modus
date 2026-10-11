import type { HarnessContext } from "../kernel/harness-hooks";

export type PromptSection = {
  id: string;
  priority: number;
  content: string;
  fingerprint: string;
  volatile: boolean;
};

export interface PromptSectionProvider {
  getSectionId(): string;
  getPriority(): number;
  isVolatile(): boolean;
  buildContent(context: HarnessContext): Promise<string> | string;
}
