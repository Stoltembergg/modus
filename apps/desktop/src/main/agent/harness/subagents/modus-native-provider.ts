import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentSpawnInput,
  SubagentSpawnResult,
  SubagentStatus,
  SubagentWaitResult,
} from "./subagent-provider";

export type ModusNativeDispatchDelegate = {
  spawnSubagent?: ((input: SubagentSpawnInput) => Promise<SubagentSpawnResult>) | undefined;
  waitSubagent?: ((subagentId: string, timeoutMs?: number) => Promise<SubagentWaitResult>) | undefined;
  stopSubagent?: ((subagentId: string) => Promise<void>) | undefined;
  getSubagentStatus?: ((subagentId: string) => Promise<SubagentStatus>) | undefined;
};

/**
 * ModusNativeSubagentProvider
 * Implements SubagentProvider integrating with Modus's native task/wait mechanism
 * and Git worktree isolation.
 */
export class ModusNativeSubagentProvider implements SubagentProvider {
  readonly name = "modus-native";

  /**
   * Capabilities reflect what is actually dispatchable: without a wired
   * dispatch delegate there is no backing task/wait machinery, so the
   * provider honestly advertises nothing instead of claiming worktree,
   * wait and streaming support it cannot honor.
   */
  get capabilities(): SubagentCapabilities {
    if (!this.delegate) {
      return {
        supportsWorktrees: false,
        supportsWait: false,
        supportsStreaming: false,
        maxConcurrent: 0,
      };
    }
    return {
      supportsWorktrees: true,
      supportsWait: true,
      supportsStreaming: true,
      maxConcurrent: 6,
    };
  }

  private delegate: ModusNativeDispatchDelegate | undefined;

  constructor(delegate?: ModusNativeDispatchDelegate | undefined) {
    this.delegate = delegate;
  }

  setDelegate(delegate: ModusNativeDispatchDelegate | undefined): void {
    this.delegate = delegate;
  }

  async spawn(input: SubagentSpawnInput): Promise<SubagentSpawnResult> {
    if (this.delegate?.spawnSubagent) {
      return this.delegate.spawnSubagent(input);
    }

    // Fail closed: without a wired dispatch delegate there is no real
    // task/wait machinery behind this provider. Minting an id and reporting
    // success would let callers believe work happened that never did.
    return {
      subagentId: "unavailable",
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      status: "failed",
      errorMessage:
        "ModusNativeSubagentProvider has no dispatch delegate wired: spawn refused instead of fabricating a subagent.",
    };
  }

  async wait(subagentId: string, timeoutMs: number = 30000): Promise<SubagentWaitResult> {
    if (this.delegate?.waitSubagent) {
      return this.delegate.waitSubagent(subagentId, timeoutMs);
    }

    return {
      subagentId,
      success: false,
      error: `Subagent ${subagentId} not found`,
    };
  }

  async stop(subagentId: string): Promise<void> {
    if (this.delegate?.stopSubagent) {
      return this.delegate.stopSubagent(subagentId);
    }
    // No local bookkeeping exists without a delegate: nothing to abort.
  }

  async status(subagentId: string): Promise<SubagentStatus> {
    if (this.delegate?.getSubagentStatus) {
      return this.delegate.getSubagentStatus(subagentId);
    }

    return {
      subagentId,
      state: "failed",
      error: `Unknown subagent ${subagentId}`,
    };
  }
}
