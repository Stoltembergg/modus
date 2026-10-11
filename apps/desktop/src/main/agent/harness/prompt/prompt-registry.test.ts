import { describe, expect, it } from "vitest";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import type { HarnessContext } from "../kernel/harness-hooks";
import { promptBuildHook } from "../kernel/prompt-hook";
import { detectChanges, fingerprintSection } from "./prompt-differ";
import { PromptRegistry } from "./prompt-registry";
import type { PromptSection } from "./prompt-section";

describe("Fase 2: PromptRegistry & Modular Prompt Assembly", () => {
  it("2.1 Generates deterministic SHA-256 fingerprints for prompt sections", () => {
    const text1 = "You are Modus, an agentic AI software engineering partner.";
    const text2 = "You are Modus, an agentic AI software engineering partner.";
    const text3 = "You are an assistant.";

    const fp1 = fingerprintSection(text1);
    const fp2 = fingerprintSection(text2);
    const fp3 = fingerprintSection(text3);

    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp1.length).toBe(16);
  });

  it("2.2 Detects changed vs unchanged sections across turns", () => {
    const sections = new Map<string, PromptSection>([
      [
        "persona",
        {
          id: "persona",
          priority: 100,
          content: "Static Persona Content",
          fingerprint: fingerprintSection("Static Persona Content"),
          volatile: false,
        },
      ],
      [
        "memory",
        {
          id: "memory",
          priority: 400,
          content: "Dynamic Memory Turn 1",
          fingerprint: fingerprintSection("Dynamic Memory Turn 1"),
          volatile: true,
        },
      ],
    ]);

    // Initial turn: previous fingerprints map is empty, so everything is changed
    const prevEmpty = new Map<string, string>();
    const initialChanges = detectChanges(prevEmpty, sections);
    expect(initialChanges).toContain("persona");
    expect(initialChanges).toContain("memory");

    // After marking persona as sent:
    const prevTurn1 = new Map<string, string>([
      ["persona", sections.get("persona")!.fingerprint],
      ["memory", sections.get("memory")!.fingerprint],
    ]);

    // Turn 2 with same persona and memory:
    // persona is static and unchanged -> NOT in changed list
    // memory is volatile -> MUST be in changed list
    const turn2Changes = detectChanges(prevTurn1, sections);
    expect(turn2Changes).not.toContain("persona");
    expect(turn2Changes).toContain("memory");

    // When persona content changes:
    sections.get("persona")!.content = "Updated Persona Content";
    sections.get("persona")!.fingerprint = fingerprintSection("Updated Persona Content");

    const turn3Changes = detectChanges(prevTurn1, sections);
    expect(turn3Changes).toContain("persona");
    expect(turn3Changes).toContain("memory");
  });

  it("2.3 Orders static sections before volatile sections to maximize Anthropic Prompt Caching", async () => {
    const registry = new PromptRegistry();

    registry.registerSection({
      id: "context",
      priority: 500,
      content: "Volatile Context 500",
      fingerprint: "",
      volatile: true,
    });
    registry.registerSection({
      id: "persona",
      priority: 100,
      content: "Static Persona 100",
      fingerprint: "",
      volatile: false,
    });
    registry.registerSection({
      id: "skills",
      priority: 300,
      content: "Static Skills 300",
      fingerprint: "",
      volatile: false,
    });
    registry.registerSection({
      id: "rules",
      priority: 200,
      content: "Static Rules 200",
      fingerprint: "",
      volatile: false,
    });
    registry.registerSection({
      id: "memory",
      priority: 400,
      content: "Volatile Memory 400",
      fingerprint: "",
      volatile: true,
    });

    const result = await registry.assemblePrompt("session-cache-test");

    // Static sections must appear first in strict priority order (100 -> 200 -> 300)
    const personaIdx = result.prompt.indexOf("Static Persona 100");
    const rulesIdx = result.prompt.indexOf("Static Rules 200");
    const skillsIdx = result.prompt.indexOf("Static Skills 300");
    const memoryIdx = result.prompt.indexOf("Volatile Memory 400");
    const contextIdx = result.prompt.indexOf("Volatile Context 500");

    expect(personaIdx).toBeLessThan(rulesIdx);
    expect(rulesIdx).toBeLessThan(skillsIdx);
    expect(skillsIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(contextIdx);

    // Cacheable prefix should contain only static sections
    expect(result.cacheablePrefix).toContain("Static Persona 100");
    expect(result.cacheablePrefix).toContain("Static Rules 200");
    expect(result.cacheablePrefix).toContain("Static Skills 300");
    expect(result.cacheablePrefix).not.toContain("Volatile Memory 400");
    expect(result.cacheablePrefix).not.toContain("Volatile Context 500");

    // Dynamic suffix should contain volatile sections
    expect(result.dynamicSuffix).toContain("Volatile Memory 400");
    expect(result.dynamicSuffix).toContain("Volatile Context 500");
  });

  it("2.4 Performance SLO: Assembles complex prompt under 100ms (< 10ms expected)", async () => {
    const registry = PromptRegistry.createDefault();

    const mockContext: HarnessContext = {
      sessionId: "session-perf-bench",
      runId: "run-1",
      workspaceId: "ws-1",
      cwd: "C:/project",
      mode: "build",
      state: new Map<string, any>([
        ["memoryHints", [{ text: "Use Vitest for testing", scope: "test" }]],
        ["activeFiles", ["src/main.ts", "src/database.ts"]],
        ["branch", "main"],
      ]),
    };

    const start = performance.now();
    const result = await registry.assemblePrompt("session-perf-bench", { context: mockContext });
    const elapsed = performance.now() - start;

    expect(result.prompt.length).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(100); // SLO requirement: < 100ms
    expect(result.durationMs).toBeLessThan(50);
  });

  it("2.5 Simulates turn-by-turn prompt caching savings", async () => {
    const registry = PromptRegistry.createDefault();
    const sessionId = "session-caching-sim";

    const turn1Context: HarnessContext = {
      sessionId,
      runId: "run-turn-1",
      workspaceId: "ws-1",
      cwd: "C:/app",
      mode: "build",
      state: new Map([
        ["memoryHints", [{ text: "Initial hint" }]],
        ["activeFiles", ["index.ts"]],
      ]),
    };

    // Turn 1:
    const turn1 = await registry.assemblePrompt(sessionId, { context: turn1Context });
    expect(turn1.changedSectionIds.length).toBeGreaterThanOrEqual(4);
    registry.markAsSent(sessionId);

    // Turn 2: Only volatile state changes (memory and files)
    const turn2Context: HarnessContext = {
      ...turn1Context,
      runId: "run-turn-2",
      state: new Map([
        ["memoryHints", [{ text: "Updated hint for turn 2" }]],
        ["activeFiles", ["index.ts", "utils.ts"]],
      ]),
    };

    const turn2 = await registry.assemblePrompt(sessionId, { context: turn2Context });
    // Static sections (persona, rules, skills, policy) did NOT change!
    expect(turn2.changedSectionIds).not.toContain("persona");
    expect(turn2.changedSectionIds).not.toContain("rules");
    expect(turn2.changedSectionIds).not.toContain("skills");
    expect(turn2.changedSectionIds).not.toContain("policy");
    // Volatile sections changed:
    expect(turn2.changedSectionIds).toContain("memory");
    expect(turn2.changedSectionIds).toContain("context");

    // Prefix cacheable tokens ratio:
    const cacheRatio = turn2.staticPrefixTokensEstimate / turn2.totalTokensEstimate;
    expect(cacheRatio).toBeGreaterThan(0.5); // Over 50% of the prompt is static prefix cacheable!
  });

  it("2.6 Integrates with promptBuildHook when MODUS_PROMPT_REGISTRY is enabled", async () => {
    setFeatureFlagOverrides({
      MODUS_USE_KERNEL: true,
      MODUS_PROMPT_REGISTRY: true,
    });

    try {
      const mockContext: HarnessContext = {
        sessionId: "session-hook-test",
        runId: "run-hook-1",
        workspaceId: "ws-test",
        cwd: "C:/app",
        mode: "build",
        state: new Map<string, any>([
          ["branch", "feat/prompt-registry"],
          ["activeFiles", ["app.ts"]],
        ]),
      };

      const output = await promptBuildHook.execute(
        {
          basePrompt: "Custom System Directive",
          systemSections: [
            { id: "custom_sec", priority: 150, content: "Custom Section Content", volatile: false },
          ],
        },
        mockContext,
      );

      expect(output.finalSystemPrompt).toContain("Custom System Directive");
      expect(output.finalSystemPrompt).toContain("Custom Section Content");
      expect(output.finalSystemPrompt).toContain("Operational Rules:");
      expect(output.finalSystemPrompt).toContain("Current Git Branch: feat/prompt-registry");

      const assemblyResult = mockContext.state.get("prompt_assembly_result");
      expect(assemblyResult).toBeDefined();
    } finally {
      resetFeatureFlagOverrides();
    }
  });
});
