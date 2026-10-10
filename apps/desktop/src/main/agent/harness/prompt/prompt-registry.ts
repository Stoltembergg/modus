import type { HarnessContext } from "../kernel/harness-hooks";
import { detectChanges, fingerprintSection } from "./prompt-differ";
import type { PromptSection, PromptSectionProvider } from "./prompt-section";
import { ContextSectionProvider } from "./sections/context-section";
import { MemorySectionProvider } from "./sections/memory-section";
import { PersonaSectionProvider } from "./sections/persona-section";
import { PolicySectionProvider } from "./sections/policy-section";
import { RulesSectionProvider } from "./sections/rules-section";
import { SkillsSectionProvider } from "./sections/skills-section";

export interface CacheControlBlock {
  type: "text";
  text: string;
  cacheControl?: { type: "ephemeral" } | undefined;
}

export interface PromptAssemblyResult {
  prompt: string;
  changedSectionIds: string[];
  totalTokensEstimate: number;
  staticPrefixTokensEstimate: number;
  staticRatio: number;
  cacheablePrefix: string;
  dynamicSuffix: string;
  systemBlocks: CacheControlBlock[];
  cacheBreakpointSectionId?: string | undefined;
  durationMs: number;
}

export class PromptRegistry {
  private sections: Map<string, PromptSection> = new Map();
  private providers: Map<string, PromptSectionProvider> = new Map();
  /**
   * Tracks the fingerprints of sections sent to each session.
   * sessionId -> (sectionId -> fingerprint)
   */
  private sessionFingerprints: Map<string, Map<string, string>> = new Map();

  /**
   * Directly registers or replaces a prompt section.
   */
  registerSection(section: PromptSection): void {
    this.sections.set(section.id, {
      ...section,
      fingerprint: section.fingerprint || fingerprintSection(section.content),
    });
  }

  /**
   * Unregisters a prompt section.
   */
  unregisterSection(id: string): boolean {
    return this.sections.delete(id);
  }

  /**
   * Registers a dynamic section provider.
   */
  registerProvider(provider: PromptSectionProvider): void {
    this.providers.set(provider.getSectionId(), provider);
  }

  /**
   * Unregisters a dynamic section provider.
   */
  unregisterProvider(id: string): boolean {
    this.sections.delete(id);
    return this.providers.delete(id);
  }

  /**
   * Updates the content of an existing section and recalculates its fingerprint.
   */
  updateSection(id: string, content: string): void {
    const existing = this.sections.get(id);
    if (existing) {
      existing.content = content;
      existing.fingerprint = fingerprintSection(content);
    } else {
      this.registerSection({
        id,
        priority: 500,
        content,
        fingerprint: fingerprintSection(content),
        volatile: false,
      });
    }
  }

  /**
   * Returns a section by id.
   */
  getSection(id: string): PromptSection | undefined {
    return this.sections.get(id);
  }

  /**
   * Returns all sections currently registered.
   */
  getAllSections(): PromptSection[] {
    return Array.from(this.sections.values());
  }

  /**
   * Executes registered providers to update dynamic and static sections against the current context.
   * Handles individual provider errors gracefully without aborting the refresh cycle.
   */
  async refreshProviders(context: HarnessContext): Promise<void> {
    for (const provider of this.providers.values()) {
      try {
        const content = await provider.buildContent(context);
        if (content && content.trim().length > 0) {
          this.sections.set(provider.getSectionId(), {
            id: provider.getSectionId(),
            priority: provider.getPriority(),
            content,
            fingerprint: fingerprintSection(content),
            volatile: provider.isVolatile(),
          });
        } else {
          // If provider returned empty string, remove it from active assembly
          this.sections.delete(provider.getSectionId());
        }
      } catch (err: any) {
        console.warn(
          `[modus] PromptSectionProvider '${provider.getSectionId()}' failed during refresh: ${err?.message || err}. Continuing.`,
        );
      }
    }
  }

  /**
   * Returns the list of sections that have changed (or are volatile) for a session.
   */
  getChangedSections(sessionId: string): PromptSection[] {
    const prev = this.sessionFingerprints.get(sessionId) ?? new Map<string, string>();
    const changedIds = detectChanges(prev, this.sections);
    return changedIds
      .map((id) => this.sections.get(id))
      .filter((s): s is PromptSection => s !== undefined);
  }

  /**
   * Marks specified sections (or all registered sections) as sent for the given session.
   */
  markAsSent(sessionId: string, sectionIds?: string[]): void {
    let sessionMap = this.sessionFingerprints.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map<string, string>();
      this.sessionFingerprints.set(sessionId, sessionMap);
    }

    const idsToMark = sectionIds ?? Array.from(this.sections.keys());
    for (const id of idsToMark) {
      const sec = this.sections.get(id);
      if (sec) {
        sessionMap.set(id, sec.fingerprint);
      }
    }
  }

  /**
   * Resets sent tracking for a given session.
   */
  resetSession(sessionId: string): void {
    this.sessionFingerprints.delete(sessionId);
  }

  /**
   * Clean up session tracking state. Alias for resetSession.
   */
  cleanSession(sessionId: string): void {
    this.resetSession(sessionId);
  }

  /**
   * Cleans up all sessions tracking state.\
   */
  clearAllSessions(): void {
    this.sessionFingerprints.clear();
  }

  /**
   * Returns active sessions count being tracked.
   */
  getTrackedSessionCount(): number {
    return this.sessionFingerprints.size;
  }

  /**
   * Assembles the complete prompt deterministically and reports heuristic token
   * estimates. `systemBlocks` is descriptive output only; the Pi runtime sends
   * the assembled string and does not forward provider-specific cache metadata.
   */
  async assemblePrompt(
    sessionId: string,
    options?: { full?: boolean; context?: HarnessContext },
  ): Promise<PromptAssemblyResult> {
    const start = performance.now();

    if (options?.context) {
      await this.refreshProviders(options.context);
    }

    const sections = Array.from(this.sections.values());

    // Separate static (cacheable prefix) from volatile (dynamic suffix)
    const staticSections = sections
      .filter((s) => !s.volatile)
      .sort((a, b) => a.priority - b.priority);

    const volatileSections = sections
      .filter((s) => s.volatile)
      .sort((a, b) => a.priority - b.priority);

    const cacheablePrefix = staticSections.map((s) => s.content.trim()).join("\n\n");
    const dynamicSuffix = volatileSections.map((s) => s.content.trim()).join("\n\n");

    const prompt = dynamicSuffix ? `${cacheablePrefix}\n\n${dynamicSuffix}` : cacheablePrefix;

    const changed = this.getChangedSections(sessionId);
    const changedSectionIds = changed.map((s) => s.id);

    // Rough token heuristic: 4 chars ~ 1 token
    const totalTokensEstimate = Math.ceil(prompt.length / 4);
    const staticPrefixTokensEstimate = Math.ceil(cacheablePrefix.length / 4);
    const staticRatio = prompt.length > 0 ? cacheablePrefix.length / prompt.length : 0;

    const systemBlocks: CacheControlBlock[] = [];
    let cacheBreakpointSectionId: string | undefined = undefined;

    if (cacheablePrefix.length > 0) {
      const lastStatic = staticSections[staticSections.length - 1];
      cacheBreakpointSectionId = lastStatic?.id;
      systemBlocks.push({
        type: "text",
        text: cacheablePrefix,
        cacheControl: { type: "ephemeral" },
      });
    }

    if (dynamicSuffix.length > 0) {
      systemBlocks.push({
        type: "text",
        text: dynamicSuffix,
      });
    }

    const durationMs = performance.now() - start;
    if (durationMs > 100) {
      console.warn(
        `[modus] PromptRegistry.assemblePrompt took ${durationMs.toFixed(2)}ms (SLO: 100ms)`,
      );
    }

    return {
      prompt,
      changedSectionIds,
      totalTokensEstimate,
      staticPrefixTokensEstimate,
      staticRatio,
      cacheablePrefix,
      dynamicSuffix,
      systemBlocks,
      cacheBreakpointSectionId,
      durationMs,
    };
  }

  /**
   * Convenience alias to assemble prompt from a HarnessContext.
   */
  async assemble(context: HarnessContext): Promise<PromptAssemblyResult> {
    return this.assemblePrompt(context.sessionId, { context });
  }

  /**
   * Factory creating a pre-configured PromptRegistry with default standard providers.
   */
  static createDefault(): PromptRegistry {
    const registry = new PromptRegistry();
    registry.registerProvider(new PersonaSectionProvider());
    registry.registerProvider(new RulesSectionProvider());
    registry.registerProvider(new SkillsSectionProvider());
    registry.registerProvider(new PolicySectionProvider());
    registry.registerProvider(new MemorySectionProvider());
    registry.registerProvider(new ContextSectionProvider());
    return registry;
  }
}
