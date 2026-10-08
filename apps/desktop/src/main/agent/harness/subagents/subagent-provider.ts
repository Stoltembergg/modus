/**
 * SubagentProvider Interfaces and Capabilities
 * DeepSeek-inspired modular interface for subagent dispatching, isolated worktree execution,
 * and unified waiting/harvesting.
 */

export type SubagentCapabilities = {
  supportsWorktrees: boolean;
  supportsWait: boolean;
  supportsStreaming: boolean;
  maxConcurrent: number;
};

export type SubagentSpawnInput = {
  role: string;
  task: string;
  context?: any[] | undefined;
  isolation?: "worktree" | "none" | undefined;
  readOnly?: boolean | undefined;
  sessionId?: string | undefined;
  cwd?: string | undefined;
};

export type SubagentSpawnResult = {
  subagentId: string;
  sessionId?: string | undefined;
  status: "spawned" | "queued" | "failed";
  errorMessage?: string | undefined;
};

export type SubagentStatus = {
  subagentId: string;
  state: "running" | "completed" | "failed" | "aborted" | "queued";
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  error?: string | undefined;
};

export type SubagentWaitResult = {
  subagentId: string;
  output?: string | undefined;
  error?: string | undefined;
  success: boolean;
  durationMs?: number | undefined;
};

export interface SubagentProvider {
  readonly name: string;
  readonly capabilities: SubagentCapabilities;

  spawn(input: SubagentSpawnInput): Promise<SubagentSpawnResult>;
  wait(subagentId: string, timeoutMs?: number): Promise<SubagentWaitResult>;
  stop(subagentId: string): Promise<void>;
  status(subagentId: string): Promise<SubagentStatus>;
}
