import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("PI SDK Integration & Harness Feasibility POC", () => {
  it("POC 1: Tool Result Interception & Spill Hook", async () => {
    let hookExecuted = false;
    const largePayload = "X".repeat(120 * 1024);

    const spillExtension: ExtensionFactory = (pi) => {
      pi.on("tool_result", async (event) => {
        hookExecuted = true;
        const textContent = event.content.find((c) => c.type === "text");
        if (textContent && textContent.type === "text" && textContent.text.length > 50000) {
          return {
            content: [
              {
                type: "text",
                text: `[Output spilled: ${textContent.text.length} chars. Head: ${textContent.text.slice(0, 50)}... Tail: ${textContent.text.slice(-50)}]`,
              },
            ],
          };
        }
        return undefined;
      });
    };

    const sessionManager = SessionManager.inMemory();
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      settingsManager,
      extensionFactories: [spillExtension],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    // 1a. Test extension runner directly
    const runner = (session as any)._extensionRunner;
    expect(runner.hasHandlers("tool_result")).toBe(true);

    const hookResult = await runner.emitToolResult({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call_1",
      input: { command: "cat large.txt" },
      content: [{ type: "text", text: largePayload }],
      details: {},
      isError: false,
    });

    expect(hookExecuted).toBe(true);
    expect(hookResult).toBeDefined();
    expect(hookResult.content[0].type).toBe("text");
    expect(hookResult.content[0].text).toContain("[Output spilled: 122880 chars.");
    expect(hookResult.content[0].text.length).toBeLessThan(500);

    // 1b. Test agent.afterToolCall wiring (agent loop boundary)
    const afterCallResult = await session.agent.afterToolCall!(
      {
        assistantMessage: {} as any,
        toolCall: { id: "call_2", name: "bash", arguments: { command: "cat large.txt" } } as any,
        args: { command: "cat large.txt" },
        result: {
          content: [{ type: "text", text: largePayload }],
          details: {},
        },
        isError: false,
        context: {} as any,
      },
      new AbortController().signal,
    );

    expect(afterCallResult).toBeDefined();
    expect(afterCallResult?.content?.[0]?.type).toBe("text");
    expect((afterCallResult?.content?.[0] as any).text).toContain("[Output spilled: 122880 chars.");
  });

  it("POC 2: Compaction Interception via session_before_compact Hook", async () => {
    let beforeCompactFired = false;
    let cancelAttempted = false;

    const compactionExtension: ExtensionFactory = (pi) => {
      pi.on("session_before_compact", async (event) => {
        beforeCompactFired = true;
        expect(event.reason).toBe("threshold");
        expect(event.preparation).toBeDefined();

        if (cancelAttempted) {
          return { cancel: true };
        }

        return {
          compaction: {
            summary: "Custom Pruned Architectural Compaction Summary",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: 42000,
            details: { customPrunedTurns: 5 },
          },
        };
      });
    };

    const sessionManager = SessionManager.inMemory();
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      settingsManager,
      extensionFactories: [compactionExtension],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    const runner = (session as any)._extensionRunner;
    expect(runner.hasHandlers("session_before_compact")).toBe(true);

    const result = await runner.emit({
      type: "session_before_compact",
      preparation: {
        messagesToSummarize: [],
        turnPrefixMessages: [],
        previousSummary: undefined,
        fileOps: [],
        tokensBefore: 42000,
        firstKeptEntryId: "entry_10",
        settings: settingsManager.getCompactionSettings(),
      },
      branchEntries: [],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });

    expect(beforeCompactFired).toBe(true);
    expect(result.compaction.summary).toBe("Custom Pruned Architectural Compaction Summary");
    expect(result.compaction.details.customPrunedTurns).toBe(5);

    // Test cancellation
    cancelAttempted = true;
    const cancelResult = await runner.emit({
      type: "session_before_compact",
      preparation: {
        messagesToSummarize: [],
        turnPrefixMessages: [],
        previousSummary: undefined,
        fileOps: [],
        tokensBefore: 42000,
        firstKeptEntryId: "entry_10",
        settings: settingsManager.getCompactionSettings(),
      },
      branchEntries: [],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });

    expect(cancelResult.cancel).toBe(true);
  });

  it("POC 3: Context & System Prompt Mutation Hooks", async () => {
    let beforeAgentStartFired = false;
    let contextHookFired = false;

    const promptExtension: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", async (event) => {
        beforeAgentStartFired = true;
        return {
          systemPrompt: `${event.systemPrompt}\n\n<!-- MODUS_INJECTED_SECTION: PromptRegistry -->\nAdhere strictly to DeepSeek code guidelines.`,
        };
      });

      pi.on("context", async (event) => {
        contextHookFired = true;
        return {
          messages: event.messages.map((m) => {
            if (m.role === "user") {
              return { ...m, timestamp: 12345 };
            }
            return m;
          }),
        };
      });
    };

    const sessionManager = SessionManager.inMemory();
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      settingsManager,
      extensionFactories: [promptExtension],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    const runner = (session as any)._extensionRunner;
    expect(runner.hasHandlers("before_agent_start")).toBe(true);
    expect(runner.hasHandlers("context")).toBe(true);

    const startResult = await runner.emitBeforeAgentStart(
      "Hello agent",
      undefined,
      "Base System Prompt",
      {},
    );

    expect(beforeAgentStartFired).toBe(true);
    expect(startResult.systemPrompt).toContain("Base System Prompt");
    expect(startResult.systemPrompt).toContain("<!-- MODUS_INJECTED_SECTION: PromptRegistry -->");

    const contextResult = await runner.emitContext([
      { role: "user", content: [{ type: "text", text: "Test message" }] },
    ]);

    expect(contextHookFired).toBe(true);
    expect((contextResult[0] as any).timestamp).toBe(12345);
  });

  it("POC 4: SettingsManager Compaction Control", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: false,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      },
    });

    expect(settingsManager.getCompactionSettings().enabled).toBe(false);
    expect(settingsManager.getCompactionSettings().reserveTokens).toBe(16384);

    settingsManager.setCompactionEnabled(true);
    expect(settingsManager.getCompactionSettings().enabled).toBe(true);
  });
});
