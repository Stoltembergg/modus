export type AgentEvent =
  | HarnessRouteEvent
  | { type: "harness.task_state"; sessionId: string; runId: string; state: HarnessTaskState }
  | {
      type: "harness.decision";
      sessionId: string;
      runId: string;
      decision: AdaptiveDecision;
    };
