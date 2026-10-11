import { getFeatureFlags } from "../feature-flags";
import { PromptRegistry } from "../prompt/prompt-registry";
import type {
  HarnessContext,
  HarnessHook,
  PromptBuildInput,
  PromptBuildOutput,
} from "./harness-hooks";

/**
 * Standard Prompt Build Hook:
 * Assembles system prompt sections in a deterministic, cache-optimized order.
 * If MODUS_PROMPT_REGISTRY is enabled, uses PromptRegistry with change detection and caching metrics.
 */
export const promptBuildHook: HarnessHook<PromptBuildInput, PromptBuildOutput> = {
  name: "prompt_build_assembler",
  phase: "prompt_build",
  priority: 10,
  isCritical: true,
  execute: async (input: PromptBuildInput, context: HarnessContext): Promise<PromptBuildOutput> => {
    const flags = getFeatureFlags();

    if (flags.MODUS_PROMPT_REGISTRY) {
      let registry = context.state.get("promptRegistry") as PromptRegistry | undefined;
      if (!registry) {
        registry = PromptRegistry.createDefault();
        context.state.set("promptRegistry", registry);
      }

      // A runtime-owned registry contains only the current SDK prompt sections.
      // Remove sections that disappeared on this turn so stale workspace or
      // persona instructions cannot survive a prompt refresh.
      if (context.state.get("promptRegistryManagedSections") === true) {
        const activeIds = new Set(input.systemSections?.map((section) => section.id) ?? []);
        if (input.basePrompt.trim().length > 0) activeIds.add("base_prompt");
        for (const section of registry.getAllSections()) {
          if (!activeIds.has(section.id)) registry.unregisterSection(section.id);
        }
      }

      // If custom system sections were passed in input, update them into the registry.
      for (const sec of input.systemSections ?? []) {
        registry.registerSection({
          id: sec.id,
          priority: sec.priority ?? (sec.volatile ? 500 : 250),
          content: sec.content,
          fingerprint: "",
          volatile: !!sec.volatile,
        });
      }

      if (input.basePrompt && input.basePrompt.trim().length > 0) {
        registry.registerSection({
          id: "base_prompt",
          priority: 50,
          content: input.basePrompt,
          fingerprint: "",
          volatile: false,
        });
      }

      const assembly = await registry.assemblePrompt(context.sessionId, { context });
      context.state.set("prompt_assembly_result", assembly);
      context.state.set("final_system_prompt", assembly.prompt);
      context.state.set("prompt_estimates", {
        totalTokensEstimate: assembly.totalTokensEstimate,
        staticRatio: assembly.staticRatio,
        staticPrefixTokensEstimate: assembly.staticPrefixTokensEstimate,
      });

      return {
        finalSystemPrompt: assembly.prompt,
        activePromptSections: registry.getAllSections().map((s) => ({
          id: s.id,
          content: s.content,
          volatile: s.volatile,
        })),
      };
    }

    // Default / fallback pipeline when MODUS_PROMPT_REGISTRY is disabled:
    const sections = input.systemSections || [];

    // Order: static/persona sections first for prompt caching, dynamic/volatile sections last
    const sortedSections = [...sections].sort((a, b) => {
      const aVol = a.volatile ? 1 : 0;
      const bVol = b.volatile ? 1 : 0;
      return aVol - bVol;
    });

    const assembledParts: string[] = [input.basePrompt];
    for (const section of sortedSections) {
      if (section.content && section.content.trim().length > 0) {
        assembledParts.push(section.content.trim());
      }
    }

    const finalSystemPrompt = assembledParts.join("\n\n");
    context.state.set("final_system_prompt", finalSystemPrompt);

    return {
      finalSystemPrompt,
      activePromptSections: sortedSections.map((s) => ({
        id: s.id,
        content: s.content,
        volatile: !!s.volatile,
      })),
    };
  },
};
