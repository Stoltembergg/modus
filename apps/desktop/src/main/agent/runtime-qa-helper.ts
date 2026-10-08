import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessTaskCheckKind,
  PlanEvidenceRef,
  PlanRef,
} from "../../shared/contracts";
import { getGroupTask } from "../groups/group-task-store";
import { hashContent, isPlanCriterionLinkedToTodos } from "../plan/plan-store";
import {
  getLatestCheckpointRestoreRowId,
  getRunToolEvidence,
} from "./agent-event-store";
import {
  type RunQAEvent,
  recognizeCheckInvocation,
  resolvePackageCheckScript,
  summarizeRunQA,
} from "./harness/qa-evidence";
import type { PromptAgentInput } from "./runtime";

export function negatedCheckAction(text: string, actionStart: number): boolean {
  const before = text.slice(0, actionStart);
  const boundaries = /[.!?;,\n]|\b(?:but|however|instead)\b/gi;
  let clauseStart = 0;
  for (const match of before.matchAll(boundaries)) {
    clauseStart = (match.index ?? 0) + match[0].length;
  }
  return /\b(?:do\s+not|don't|dont|never|avoid|skip|not)\s*$/i.test(before.slice(clauseStart));
}

export function negatedCheckTarget(text: string, targetStart: number): boolean {
  const before = text.slice(0, targetStart);
  const boundaries = /[.!?;,\n]|\b(?:but|however|instead)\b/gi;
  let clauseStart = 0;
  for (const match of before.matchAll(boundaries)) {
    clauseStart = (match.index ?? 0) + match[0].length;
  }
  return /\b(?:do\s+not|don't|dont|never|avoid|skip)\s+(?:(?:run|execute|rerun|verify|check)\s+)?$/i.test(
    before.slice(clauseStart),
  );
}

export function requestsCheck(text: string, target: RegExp): boolean {
  const actions = /\b(?:run|execute|rerun|verify|check)\b/gi;
  const clauseBoundaries =
    /[.!?;,\n]|\b(?:but|however|instead)\b|\b(?:run|execute|rerun|verify|check)\b/gi;
  const targetMatches = new RegExp(target.source, `${target.flags.replace(/[gy]/g, "")}g`);
  for (const action of text.matchAll(actions)) {
    const start = action.index ?? 0;
    const afterAction = start + action[0].length;
    clauseBoundaries.lastIndex = afterAction;
    const boundary = clauseBoundaries.exec(text);
    const targetWindow = text.slice(start, boundary?.index ?? text.length);
    if (
      !negatedCheckAction(text, start) &&
      [...targetWindow.matchAll(targetMatches)].some(
        (match) => !negatedCheckTarget(text, start + (match.index ?? 0)),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function requiredChecksForRun(input: PromptAgentInput, plan?: PlanRef): HarnessTaskCheckKind[] {
  if ((input.mode ?? "build") !== "build") return [];
  const text = input.message;
  const checks: HarnessTaskCheckKind[] = [];
  if (requestsCheck(text, /\b(?:tests?|vitest|jest)\b/i)) {
    checks.push("tests");
  }
  if (requestsCheck(text, /\btype[ -]?check\b/i)) {
    checks.push("typecheck");
  }
  if (requestsCheck(text, /\b(?:lint|eslint|biome)\b/i)) {
    checks.push("lint");
  }
  if (requestsCheck(text, /\bbuild\b/i)) {
    checks.push("build");
  }
  if (plan?.spec) {
    for (const criterion of plan.spec.acceptanceCriteria) {
      if (isPlanCriterionLinkedToTodos(criterion, plan.todos)) {
        checks.push(...(criterion.requiredCheckKinds ?? []));
      }
    }
  }
  if (input.groupTask) {
    try {
      const task = getGroupTask(input.groupTask.taskId);
      if (
        task.groupId === input.groupTask.groupId &&
        task.executionId === input.groupTask.executionId &&
        task[input.groupTask.role === "owner" ? "ownerSessionId" : "reviewerSessionId"] ===
          input.sessionId
      ) {
        for (const criterion of task.criteria ?? []) checks.push(...criterion.requiredCheckKinds);
      }
    } catch {
      /* A stale task seed must not remove the existing harness checks. */
    }
  }
  return [...new Set(checks)];
}

export const PLAN_CHECK_LABELS: Record<string, string> = {
  tests: "Tests",
  typecheck: "Typecheck",
  lint: "Lint",
  build: "Build",
};

export function planEvidenceFromQA(
  plan: PlanRef,
  qa: ReturnType<typeof summarizeRunQA>,
): PlanEvidenceRef[] {
  if (!plan.spec) return [];
  const evidence: PlanEvidenceRef[] = [];
  for (const criterion of plan.spec.acceptanceCriteria) {
    if (
      !isPlanCriterionLinkedToTodos(criterion, plan.todos) ||
      !criterion.requiredCheckKinds?.length
    ) {
      continue;
    }
    for (const checkKind of criterion.requiredCheckKinds) {
      const label = PLAN_CHECK_LABELS[checkKind];
      if (!label) continue;
      const qaEvidence = qa.evidence.find((item) => item.label === label);
      const reference = qaEvidence ?? {
        id: `missing:${plan.id}:${criterion.id}:${checkKind}`,
        kind: "check",
        status: "missing" as const,
        label,
      };
      evidence.push({
        ...reference,
        id: hashContent(`${plan.id}:${criterion.id}:${checkKind}:${reference.id}`),
        criterionId: criterion.id,
      });
    }
  }
  return evidence;
}

export const CHECK_SCRIPT_BY_KIND: Record<string, string> = {
  tests: "test",
  typecheck: "typecheck",
  lint: "lint",
  build: "build",
};
export const MAX_QA_WORKSPACE_MANIFESTS = 32;
export const MAX_QA_PACKAGE_BYTES = 256_000;

export type TrustedPackageScripts = {
  name?: string;
  scripts?: Record<string, unknown>;
  workspaces?: string[] | { packages?: string[] };
};

export function readTrustedPackageScripts(path: string): TrustedPackageScripts | undefined {
  try {
    const content = readFileSync(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_QA_PACKAGE_BYTES) return undefined;
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const scripts = parsed.scripts;
    const workspaces = parsed.workspaces;
    return {
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      ...(scripts && typeof scripts === "object" && !Array.isArray(scripts)
        ? { scripts: scripts as Record<string, unknown> }
        : {}),
      ...(Array.isArray(workspaces)
        ? { workspaces: workspaces.filter((entry): entry is string => typeof entry === "string") }
        : workspaces &&
            typeof workspaces === "object" &&
            Array.isArray((workspaces as { packages?: unknown }).packages)
          ? {
              workspaces: {
                packages: (workspaces as { packages: unknown[] }).packages.filter(
                  (entry): entry is string => typeof entry === "string",
                ),
              },
            }
          : {}),
    };
  } catch {
    return undefined;
  }
}

export function packageCheckScripts(
  scripts: Record<string, unknown> | undefined,
  requiredChecks: string[],
  cwd: string,
  workspaceName?: string,
): string[] {
  if (!scripts) return [];
  return [
    ...new Set(
      requiredChecks
        .map((check) => CHECK_SCRIPT_BY_KIND[check])
        .filter((name): name is string => {
          if (!name || typeof scripts[name] !== "string") return false;
          const resolved = resolvePackageCheckScript(cwd, workspaceName, name);
          if (!resolved || resolved.body !== scripts[name]) return false;
          const invocation = recognizeCheckInvocation("terminal_run", resolved.body);
          return Boolean(
            invocation &&
              !invocation.mutatesSource &&
              invocation.checkName ===
                requiredChecks.find((check) => CHECK_SCRIPT_BY_KIND[check] === name),
          );
        }),
    ),
  ];
}

export function eligibleCheckScripts(cwd: string, requiredChecks: string[]): string[] {
  if (requiredChecks.length === 0) return [];
  const rootManifest = readTrustedPackageScripts(join(cwd, "package.json"));
  if (!rootManifest) return [];
  const eligible = packageCheckScripts(rootManifest.scripts, requiredChecks, cwd);
  const workspacePatterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : (rootManifest.workspaces?.packages ?? []);
  let scanned = 0;
  for (const pattern of workspacePatterns) {
    const match = /^([a-zA-Z0-9._-]+)\/\*$/.exec(pattern);
    if (!match?.[1]) continue;
    let childNames: string[];
    try {
      childNames = readdirSync(join(cwd, match[1]), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    for (const childName of childNames) {
      if (scanned >= MAX_QA_WORKSPACE_MANIFESTS) return [...new Set(eligible)];
      scanned += 1;
      const manifest = readTrustedPackageScripts(join(cwd, match[1], childName, "package.json"));
      if (!manifest?.name || !/^@[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(manifest.name)) continue;
      for (const scriptName of packageCheckScripts(
        manifest.scripts,
        requiredChecks,
        cwd,
        manifest.name,
      )) {
        eligible.push(`npm --workspace ${manifest.name} run ${scriptName}`);
      }
    }
  }
  return [...new Set(eligible)];
}

export function todoContinuationMessage(eligibleScripts: string[], includeQA: boolean): string {
  const todo =
    "Continue the remaining actionable to-dos from the current list. Update their statuses as work completes.";
  if (!includeQA || eligibleScripts.length === 0) {
    return `${todo} This is the single bounded continuation for this user turn; do not request another continuation.`;
  }
  return `${todo} Required QA is still unverified. Eligible existing project check scripts: ${eligibleScripts.join(", ")}. Run only these named scripts through the current tool permission flow. This is the single bounded continuation for this user turn; do not request another continuation.`;
}

export function summarizeHarnessQA(input: {
  sessionId: string;
  runId: string;
  changedPaths: string[];
  changedScopeKnown: boolean;
  requiredChecks: string[];
  aborted?: boolean;
  runStartedRowId?: number;
}): { result: ReturnType<typeof summarizeRunQA>; restoreRowId?: number } {
  const runStartedRowId = input.runStartedRowId;
  const hasValidRunStart = Number.isSafeInteger(runStartedRowId) && (runStartedRowId ?? 0) > 0;
  const restoreRowId =
    hasValidRunStart && runStartedRowId !== undefined
      ? getLatestCheckpointRestoreRowId(input.sessionId, runStartedRowId)
      : undefined;
  const evidence = hasValidRunStart
    ? getRunToolEvidence(input.sessionId, input.runId, restoreRowId)
    : [];
  const events: RunQAEvent[] = evidence.map((event) =>
    input.aborted && event.type === "tool.ended" ? { ...event, aborted: true } : event,
  );
  if (input.aborted) {
    const endedCallIds = new Set(
      events.flatMap((event) => (event.type === "tool.ended" ? [event.toolCallId] : [])),
    );
    for (const event of events) {
      if (event.type !== "tool.started" || endedCallIds.has(event.toolCallId) || !event.checkName) {
        continue;
      }
      events.push({
        type: "tool.ended",
        sessionId: event.sessionId,
        runId: event.runId,
        eventId: `aborted:${event.eventId}`.slice(0, 240),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        checkName: event.checkName,
        ...(event.paths ? { paths: event.paths } : {}),
        error: true,
        aborted: true,
      });
    }
  }
  const result = summarizeRunQA({ ...input, events });
  if (!input.changedScopeKnown && result.required) {
    result.status = "unavailable";
    result.reasonCode = "required_check_unavailable";
    result.evidence = result.evidence.map((item) =>
      item.status === "passed" || item.status === "user_confirmed"
        ? { ...item, status: "unavailable" }
        : item,
    );
  }
  return {
    result,
    ...(restoreRowId !== undefined ? { restoreRowId } : {}),
  };
}
