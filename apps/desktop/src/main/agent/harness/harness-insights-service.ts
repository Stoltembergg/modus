import {
  CHATS_WORKSPACE_ID,
  type HarnessInsight,
  type HarnessInsightConfidence,
  type HarnessInsightKind,
  type HarnessInsightSourceRef,
  type HarnessInsightsQuery,
  type HarnessInsightsResult,
} from "../../../shared/contracts";
import { getDatabase } from "../../db/database";
import {
  getWorkspaceHarnessInsightEvidence,
  type HarnessInsightEventEvidence,
} from "../agent-event-store";

export const MIN_COMPARABLE_EPISODES = 3;
const MAX_RUNS = 500;
const MAX_EVENTS = 5000;
const MAX_INSIGHTS = 12;
const MAX_SOURCE_REFS_PER_INSIGHT = 24;
const MAX_PATH_LENGTH = 512;
const KNOWN_TASK_TYPES = new Set([
  "implementation",
  "explore",
  "librarian",
  "oracle",
  "reviewer",
  "debugger",
  "ui-ux",
]);
const BUILTIN_ROLES = new Set(["explore", "librarian", "oracle", "reviewer", "debugger", "ui-ux"]);
const RUN_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);
const INSIGHT_EVENT_TYPES = new Set([
  "run.started",
  "run.completed",
  "run.failed",
  "tool.ended",
  "harness.route",
  "harness.qa",
  "harness.continuation",
  "harness.decision",
  "harness.failure",
  "checkpoint.restored",
  "context.updated",
  "subagent.started",
  "subagent.updated",
]);

export type HarnessInsightRun = {
  runId: string;
  sessionId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
};

export type HarnessInsightEvent = HarnessInsightEventEvidence;

export type ReduceHarnessInsightsInput = {
  workspaceId: string;
  since: string;
  until: string;
  runs: readonly HarnessInsightRun[];
  events: readonly HarnessInsightEvent[];
  limit?: number;
};

type Episode = {
  run: HarnessInsightRun;
  taskType: string;
  selectedRole?: string;
  events: HarnessInsightEvent[];
  changedPaths: Set<string>;
  contextPressure: boolean;
  tokenPressure: boolean;
  failed: boolean;
  retryCount: number;
  rollbackCount: number;
  requiredQaMissing: boolean;
  childFailure: boolean;
  routingMismatch: boolean;
};

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[a-zA-Z]:/.test(value) &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function safeRef(event: HarnessInsightEvent, fallbackRunId: string): HarnessInsightSourceRef {
  return {
    runId: event.runId ?? fallbackRunId,
    eventId: event.eventId,
  };
}

function confidenceFor(rate: number, sampleCount: number): HarnessInsightConfidence {
  if (sampleCount >= 5 && rate >= 0.75) return "high";
  if (rate >= 0.6) return "medium";
  return "low";
}

function insight(input: {
  kind: HarnessInsightKind;
  taskType: string;
  episodes: Episode[];
  signalEpisodes: Episode[];
  since: string;
  until: string;
  claim: string;
  recommendation: string;
  limitations?: string[];
  relevantEvents?: (event: HarnessInsightEvent) => boolean;
}): HarnessInsight {
  const sourceRefs: HarnessInsightSourceRef[] = [];
  const seenRefs = new Set<string>();
  for (const episode of input.signalEpisodes) {
    const relevant = episode.events.filter(input.relevantEvents ?? (() => true));
    if (relevant.length === 0) {
      const fallback = { runId: episode.run.runId };
      const key = JSON.stringify(fallback);
      if (!seenRefs.has(key)) {
        seenRefs.add(key);
        sourceRefs.push(fallback);
      }
    }
    for (const event of relevant) {
      const reference = safeRef(event, episode.run.runId);
      const key = JSON.stringify(reference);
      if (seenRefs.has(key)) continue;
      seenRefs.add(key);
      sourceRefs.push(reference);
      if (sourceRefs.length >= MAX_SOURCE_REFS_PER_INSIGHT) break;
    }
    if (sourceRefs.length >= MAX_SOURCE_REFS_PER_INSIGHT) break;
  }
  const sampleCount = input.episodes.length;
  const signalRate = input.signalEpisodes.length / Math.max(1, sampleCount);
  return {
    id: `${input.kind}:${input.taskType}`,
    kind: input.kind,
    claim: input.claim.slice(0, 240),
    recommendation: input.recommendation.slice(0, 320),
    hypothesis: true,
    period: { since: input.since, until: input.until },
    sampleCount,
    confidence: confidenceFor(signalRate, sampleCount),
    limitations: [
      "Hypothesis from structured local metadata, not a causal diagnosis.",
      ...(input.limitations ?? []),
    ].slice(0, 4),
    sourceRefs,
  };
}

function createEpisodes(input: ReduceHarnessInsightsInput): Episode[] {
  const runs = input.runs
    .filter(
      (run) =>
        validId(run.runId) &&
        validId(run.sessionId) &&
        RUN_STATUSES.has(run.status) &&
        typeof run.startedAt === "string" &&
        Number.isFinite(Date.parse(run.startedAt)) &&
        run.startedAt >= input.since &&
        run.startedAt <= input.until,
    )
    .slice(-MAX_RUNS);
  const byRunId = new Map<string, Episode>();
  const bySession = new Map<string, Episode[]>();
  for (const run of runs) {
    const episode: Episode = {
      run,
      taskType: "unknown",
      events: [],
      changedPaths: new Set(),
      contextPressure: false,
      tokenPressure: false,
      failed: run.status === "failed",
      retryCount: 0,
      rollbackCount: 0,
      requiredQaMissing: false,
      childFailure: false,
      routingMismatch: false,
    };
    byRunId.set(run.runId, episode);
    const sessionEpisodes = bySession.get(run.sessionId) ?? [];
    sessionEpisodes.push(episode);
    bySession.set(run.sessionId, sessionEpisodes);
  }

  const events = input.events
    .filter(
      (event) =>
        validId(event.eventId) &&
        validId(event.sessionId) &&
        INSIGHT_EVENT_TYPES.has(event.type) &&
        typeof event.createdAt === "string" &&
        Number.isFinite(Date.parse(event.createdAt)) &&
        event.createdAt >= input.since &&
        event.createdAt <= input.until,
    )
    .slice(-MAX_EVENTS);
  for (const event of events) {
    let episode = event.runId ? byRunId.get(event.runId) : undefined;
    if (!episode) {
      const candidates = bySession.get(event.sessionId) ?? [];
      episode = [...candidates]
        .filter((candidate) => candidate.run.startedAt <= event.createdAt)
        .at(-1);
    }
    if (!episode) continue;
    episode.events.push(event);
    if (event.type === "harness.route") {
      if (event.taskType && KNOWN_TASK_TYPES.has(event.taskType)) episode.taskType = event.taskType;
      if (event.selectedRole && BUILTIN_ROLES.has(event.selectedRole)) {
        episode.selectedRole = event.selectedRole;
      }
      episode.routingMismatch = Boolean(
        episode.selectedRole &&
          BUILTIN_ROLES.has(episode.taskType) &&
          episode.selectedRole !== episode.taskType,
      );
    } else if (event.type === "run.failed") {
      episode.failed = true;
    } else if (event.type === "tool.ended") {
      if (
        event.isError ||
        event.aborted ||
        (event.exitCode !== undefined && event.exitCode !== 0)
      ) {
        episode.failed = true;
      }
    } else if (event.type === "harness.continuation") {
      episode.retryCount += 1;
    } else if (event.type === "checkpoint.restored") {
      episode.rollbackCount += 1;
    } else if (event.type === "harness.qa") {
      if (event.qaRequired && event.qaStatus !== "passed") episode.requiredQaMissing = true;
    } else if (event.type === "run.completed") {
      if (event.tokenTotal !== undefined && event.tokenTotal >= 100_000) {
        episode.tokenPressure = true;
      }
      for (const path of event.changedPaths ?? []) {
        if (validPath(path)) episode.changedPaths.add(path);
      }
    } else if (event.type === "context.updated") {
      const percent =
        event.contextPercent ??
        (event.contextTokens !== undefined && event.contextWindow
          ? (event.contextTokens / event.contextWindow) * 100
          : undefined);
      if (percent !== undefined && percent >= 80) episode.contextPressure = true;
      if (
        event.contextTokens !== undefined &&
        (event.contextTokens >= 100_000 ||
          (event.contextWindow !== undefined &&
            event.contextWindow > 0 &&
            event.contextTokens / event.contextWindow >= 0.8))
      ) {
        episode.tokenPressure = true;
      }
    } else if (event.type === "subagent.updated") {
      if (["failed", "blocked", "cancelled"].includes(event.childStatus ?? "")) {
        episode.childFailure = true;
      }
    }
  }
  return [...byRunId.values()];
}

/** Pure, bounded reducers over pre-scoped structured run/event metadata. */
export function reduceHarnessInsights(input: ReduceHarnessInsightsInput): HarnessInsightsResult {
  const outputLimit = Math.max(1, Math.min(input.limit ?? MAX_INSIGHTS, MAX_INSIGHTS));
  const episodes = createEpisodes(input);
  const groups = new Map<string, Episode[]>();
  for (const episode of episodes) {
    if (episode.taskType === "unknown") continue;
    const group = groups.get(episode.taskType) ?? [];
    group.push(episode);
    groups.set(episode.taskType, group);
  }
  const comparable = [...groups.entries()].filter(
    ([, group]) => group.length >= MIN_COMPARABLE_EPISODES,
  );
  const sampleCount = Math.max(0, ...[...groups.values()].map((group) => group.length));
  if (comparable.length === 0) {
    return {
      workspaceId: input.workspaceId,
      period: { since: input.since, until: input.until },
      evidenceState: "unknown",
      sampleCount,
      limitations: [
        `At least ${MIN_COMPARABLE_EPISODES} comparable task episodes are required; no recommendation was generated.`,
      ],
      insights: [],
    };
  }

  const insights: HarnessInsight[] = [];
  const add = (item: Omit<Parameters<typeof insight>[0], "since" | "until">): void => {
    if (insights.length >= outputLimit) return;
    insights.push({ ...insight({ ...item, since: input.since, until: input.until }) });
  };
  for (const [taskType, group] of comparable) {
    const failureEpisodes = group.filter((episode) => episode.failed || episode.retryCount > 0);
    if (failureEpisodes.length >= 2) {
      add({
        kind: "repeated_failures",
        taskType,
        episodes: group,
        signalEpisodes: failureEpisodes,
        claim: `Repeated failures or retries appeared in ${failureEpisodes.length} of ${group.length} comparable ${taskType} episodes.`,
        recommendation:
          "Review the referenced failure and retry evidence before changing the workflow.",
        relevantEvents: (event) =>
          event.type === "run.failed" ||
          event.type === "harness.continuation" ||
          event.type === "tool.ended",
      });
    }

    const pathEpisodes = new Map<string, Episode[]>();
    for (const episode of group) {
      for (const path of episode.changedPaths) {
        const matched = pathEpisodes.get(path) ?? [];
        matched.push(episode);
        pathEpisodes.set(path, matched);
      }
    }
    const repeatedPaths = [...pathEpisodes.entries()].filter(([, matches]) => matches.length >= 2);
    const rollbackEpisodes = group.filter((episode) => episode.rollbackCount > 0);
    if (repeatedPaths.length > 0 || rollbackEpisodes.length >= 2) {
      const [path, pathMatches] = repeatedPaths.sort((a, b) => b[1].length - a[1].length)[0] ?? [];
      const matches = [...new Set([...(pathMatches ?? []), ...rollbackEpisodes])];
      add({
        kind: "same_path_rework",
        taskType,
        episodes: group,
        signalEpisodes: matches,
        claim: path
          ? `The same path changed in multiple comparable ${taskType} episodes.`
          : `Rollback events appeared in multiple comparable ${taskType} episodes.`,
        recommendation:
          "Check whether the referenced changes indicate repeated rework or an unstable boundary.",
        relevantEvents: (event) =>
          event.type === "run.completed" || event.type === "checkpoint.restored",
      });
    }

    const pressureEpisodes = group.filter(
      (episode) => episode.contextPressure || episode.tokenPressure,
    );
    if (pressureEpisodes.length >= 2) {
      add({
        kind: "context_pressure",
        taskType,
        episodes: group,
        signalEpisodes: pressureEpisodes,
        claim: `High context/token usage proxy signals appeared in ${pressureEpisodes.length} of ${group.length} comparable ${taskType} episodes.`,
        recommendation:
          "Consider narrower task batches or earlier summarization; this is only a usage proxy.",
        limitations: [
          "Context percentage and token totals do not measure answer quality or waste directly.",
        ],
        relevantEvents: (event) =>
          event.type === "context.updated" || event.type === "run.completed",
      });
    }

    const delegationEpisodes = group.filter(
      (episode) => episode.routingMismatch || episode.childFailure,
    );
    if (delegationEpisodes.length >= 2) {
      add({
        kind: "delegation_mismatch",
        taskType,
        episodes: group,
        signalEpisodes: delegationEpisodes,
        claim: `Routing mismatches or unsuccessful delegated outcomes appeared in ${delegationEpisodes.length} of ${group.length} comparable ${taskType} episodes.`,
        recommendation:
          "Review the role-selection and child outcome references before adjusting routing.",
        relevantEvents: (event) =>
          event.type === "harness.route" || event.type === "subagent.updated",
      });
    }

    const verificationEpisodes = group.filter((episode) => episode.requiredQaMissing);
    if (verificationEpisodes.length >= 2) {
      add({
        kind: "missing_verification",
        taskType,
        episodes: group,
        signalEpisodes: verificationEpisodes,
        claim: `Required verification was not fully passed in ${verificationEpisodes.length} of ${group.length} comparable ${taskType} episodes.`,
        recommendation:
          "Review the check evidence and make required verification visible in the completion flow.",
        relevantEvents: (event) => event.type === "harness.qa",
      });
    }
  }
  return {
    workspaceId: input.workspaceId,
    period: { since: input.since, until: input.until },
    evidenceState: "known",
    sampleCount,
    limitations: [
      "Insights are hypotheses from bounded structured metadata, not causal conclusions.",
    ],
    insights: insights.slice(0, outputLimit),
  };
}

export function getHarnessInsights(input: HarnessInsightsQuery): HarnessInsightsResult {
  const now = new Date().toISOString();
  const workspaceId = input.workspaceId ?? "";
  const sinceDate = Date.parse(input.since);
  const untilDate = Date.now();
  const windowStart = Number.isFinite(sinceDate) ? new Date(sinceDate).toISOString() : now;
  if (
    !workspaceId ||
    workspaceId === CHATS_WORKSPACE_ID ||
    !Number.isFinite(sinceDate) ||
    sinceDate > untilDate ||
    !getDatabase().prepare("select 1 as found from workspaces where id = ?").get(workspaceId)
  ) {
    return reduceHarnessInsights({
      workspaceId,
      since: windowStart,
      until: now,
      runs: [],
      events: [],
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }
  const evidence = getWorkspaceHarnessInsightEvidence(workspaceId, windowStart, now, {
    runLimit: MAX_RUNS,
    eventLimit: MAX_EVENTS,
  });
  return reduceHarnessInsights({
    workspaceId,
    since: windowStart,
    until: now,
    runs: evidence.runs,
    events: evidence.events,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}
