import { describe, expect, it } from "vitest";
import {
  agentPromptSchema,
  browserRecentSchema,
  diffCommitOrPushSchema,
  limitsCodexEnabledSchema,
  mcpUpsertSchema,
  parseIpcInput,
  permissionDecideSchema,
} from "./schemas";

describe("IPC schemas", () => {
  const mcpInput = {
    cwd: "repo",
    name: "server",
    transport: "stdio",
    command: "run",
    enabled: true,
  };

  it("accepts exact MCP allowlist tool names without trimming them", () => {
    expect(
      parseIpcInput(
        mcpUpsertSchema,
        {
          ...mcpInput,
          readOnlyToolAllowlist: [" exact name ", "mcp_search"],
        },
        "mcp:upsert",
      ).readOnlyToolAllowlist,
    ).toEqual([" exact name ", "mcp_search"]);
  });

  it("rejects empty, oversize, and duplicate MCP allowlist names", () => {
    for (const names of [
      ["  "],
      ["x".repeat(257)],
      Array.from({ length: 101 }, (_, i) => `tool${i}`),
      ["same", "same"],
    ]) {
      expect(() =>
        parseIpcInput(
          mcpUpsertSchema,
          {
            ...mcpInput,
            readOnlyToolAllowlist: names,
          },
          "mcp:upsert",
        ),
      ).toThrow("Invalid IPC payload");
    }
  });

  it("accepts a commit-and-push payload", () => {
    expect(
      parseIpcInput(
        diffCommitOrPushSchema,
        { cwd: "repo", message: "commit", commit: true, push: true },
        "diff:commit-or-push",
      ),
    ).toEqual({ cwd: "repo", message: "commit", commit: true, push: true });
  });

  it("accepts a push-only payload (no message)", () => {
    expect(
      parseIpcInput(
        diffCommitOrPushSchema,
        { cwd: "repo", commit: false, push: true },
        "diff:commit-or-push",
      ),
    ).toEqual({ cwd: "repo", commit: false, push: true });
  });

  it("rejects committing without a message", () => {
    expect(() =>
      parseIpcInput(
        diffCommitOrPushSchema,
        { cwd: "repo", message: "", commit: true, push: false },
        "diff:commit-or-push",
      ),
    ).toThrow("Invalid IPC payload");
  });

  it("rejects a no-op (neither commit nor push)", () => {
    expect(() =>
      parseIpcInput(
        diffCommitOrPushSchema,
        { cwd: "repo", commit: false, push: false },
        "diff:commit-or-push",
      ),
    ).toThrow("Invalid IPC payload");
  });

  it("validates permission decisions", () => {
    expect(
      parseIpcInput(
        permissionDecideSchema,
        { action: "git.write", target: "git clean -f", decision: "deny" },
        "permission:decide",
      ),
    ).toEqual({ action: "git.write", target: "git clean -f", decision: "deny" });
  });

  // Regression: a prompt turn must carry its own execution params (mode, model,
  // thinking) across the IPC boundary. Dropping any of these here was the
  // root of the "stale model / thinking / plan-mode on resend" bugs.
  it("preserves per-turn execution params (mode, model, thinking)", () => {
    const parsed = parseIpcInput(
      agentPromptSchema,
      {
        sessionId: "s1",
        message: "hi",
        mode: "plan",
        model: "openai/gpt-5.5",
        thinkingLevel: "xhigh",
        thinkingVariant: "max",
      },
      "agent:prompt",
    );
    expect(parsed.mode).toBe("plan");
    expect(parsed.model).toBe("openai/gpt-5.5");
    expect(parsed.thinkingLevel).toBe("xhigh");
    expect(parsed.thinkingVariant).toBe("max");
  });

  it("validates browser recent deletion payloads", () => {
    expect(parseIpcInput(browserRecentSchema, { id: "recent-1" }, "browser:delete-recent")).toEqual(
      { id: "recent-1" },
    );
    expect(() => parseIpcInput(browserRecentSchema, { id: "" }, "browser:delete-recent")).toThrow(
      "Invalid IPC payload",
    );
  });

  it("accepts only the explicit Codex limits boolean and rejects extra inputs", () => {
    expect(
      parseIpcInput(limitsCodexEnabledSchema, { enabled: true }, "model:limits-set-codex-enabled"),
    ).toEqual({ enabled: true });
    expect(() =>
      parseIpcInput(
        limitsCodexEnabledSchema,
        { enabled: "true" },
        "model:limits-set-codex-enabled",
      ),
    ).toThrow("Invalid IPC payload");
    expect(() =>
      parseIpcInput(
        limitsCodexEnabledSchema,
        { enabled: true, provider: "x" },
        "model:limits-set-codex-enabled",
      ),
    ).toThrow("Invalid IPC payload");
  });

  it("leaves per-turn params undefined when omitted (keeps session defaults)", () => {
    const parsed = parseIpcInput(
      agentPromptSchema,
      { sessionId: "s1", message: "hi" },
      "agent:prompt",
    );
    expect(parsed.mode).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.thinkingLevel).toBeUndefined();
    expect(parsed.thinkingVariant).toBeUndefined();
  });

  it("rejects an invalid thinkingLevel", () => {
    expect(() =>
      parseIpcInput(
        agentPromptSchema,
        { sessionId: "s1", message: "hi", thinkingLevel: "ultra" },
        "agent:prompt",
      ),
    ).toThrow("Invalid IPC payload");
  });
});
