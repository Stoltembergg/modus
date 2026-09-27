import type {
  BuiltinAgentRole,
  HarnessComplexity,
  HarnessRisk,
  HarnessTaskClassification,
  HarnessTaskType,
  TaskClassificationInput,
} from "../../../shared/contracts";

export const MODERATE_FILE_COUNT_THRESHOLD = 2;
export const COMPLEX_FILE_COUNT_THRESHOLD = 4;
export const CROSS_SUBSYSTEM_FILE_COUNT_THRESHOLD = 3;
export const CROSS_SUBSYSTEM_DIRECTORY_THRESHOLD = 2;

const CATEGORY_SIGNALS: Array<{
  taskType: HarnessTaskType;
  role?: BuiltinAgentRole;
  reason: string;
  pattern: RegExp;
}> = [
  {
    taskType: "reviewer",
    role: "reviewer",
    reason: "review_request",
    pattern: /\b(review|reviewing|audit)\b/i,
  },
  {
    taskType: "debugger",
    role: "debugger",
    reason: "debug_request",
    pattern: /\b(debug|debugging|troubleshoot|root cause)\b/i,
  },
  {
    taskType: "ui-ux",
    role: "ui-ux",
    reason: "ui_request",
    pattern: /\b(visual|layout|spacing|styling|responsive|user interface|ui|ux)\b/i,
  },
  {
    taskType: "oracle",
    role: "oracle",
    reason: "architecture_request",
    pattern: /\b(architecture|architectural|design decision|trade-?off)\b/i,
  },
  {
    taskType: "librarian",
    role: "librarian",
    reason: "research_request",
    pattern: /\b(research|documentation|docs|latest api|look up)\b/i,
  },
  {
    taskType: "explore",
    role: "explore",
    reason: "exploration_request",
    pattern: /\b(find|locate|explore|map|where .* (handled|defined|lives))\b/i,
  },
  {
    taskType: "implementation",
    reason: "clear_implementation_request",
    pattern: /\b(fix|change|update|implement|add|remove|build|create|refactor)\b/i,
  },
];

const RISK_SIGNALS = [
  {
    pattern: /\b(security|secure|vulnerability|authentication|authorization)\b/i,
    reason: "security_signal",
  },
  { pattern: /\b(migration|migrate|schema migration)\b/i, reason: "migration_signal" },
  { pattern: /\b(destructive|delete|remove|wipe|drop)\b/i, reason: "destructive_signal" },
];

function normalizedPaths(paths: string[]): string[] {
  return [
    ...new Set(paths.map((path) => path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase())),
  ];
}

function subsystem(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const sourceRootIndex = segments.indexOf("src");
  if (sourceRootIndex >= 0) return segments[sourceRootIndex + 1] ?? "";
  return segments.length > 1 ? (segments[0] ?? "") : "";
}

export function classifyHarnessTask(input: TaskClassificationInput): HarnessTaskClassification {
  const text = input.text.trim();
  const matchedCategories = CATEGORY_SIGNALS.filter(({ pattern }) => pattern.test(text));
  const category = matchedCategories[0];
  const hasMixedSpecialistImplementationIntent =
    matchedCategories.some(({ role }) => role !== undefined) &&
    matchedCategories.some(({ taskType }) => taskType === "implementation");
  const reasons: string[] = [];

  reasons.push(...matchedCategories.map(({ reason }) => reason));
  if (hasMixedSpecialistImplementationIntent)
    reasons.push("mixed_specialist_implementation_intent");

  const riskReasons = RISK_SIGNALS.filter(({ pattern }) => pattern.test(text)).map(
    ({ reason }) => reason,
  );
  reasons.push(...riskReasons);
  if (input.hasDestructiveAction) reasons.push("destructive_action");

  const paths = normalizedPaths([...input.contextPaths, ...input.changedPaths]);
  const changedPaths = normalizedPaths(input.changedPaths);
  const subsystemCount = new Set(paths.map(subsystem).filter((value) => value.length > 0)).size;
  const crossSubsystem =
    paths.length >= CROSS_SUBSYSTEM_FILE_COUNT_THRESHOLD &&
    subsystemCount >= CROSS_SUBSYSTEM_DIRECTORY_THRESHOLD;

  let complexity: HarnessComplexity = "simple";
  if (paths.length >= COMPLEX_FILE_COUNT_THRESHOLD || crossSubsystem) {
    complexity = "complex";
    reasons.push(crossSubsystem ? "cross_subsystem_scope" : "many_files_in_scope");
  } else if (paths.length >= MODERATE_FILE_COUNT_THRESHOLD) {
    complexity = "moderate";
    reasons.push("multiple_files_in_scope");
  } else if (category?.role) {
    complexity = "moderate";
    reasons.push("specialist_task");
  } else if (changedPaths.length === 1) {
    reasons.push("single_file_change");
  }

  if (changedPaths.length >= MODERATE_FILE_COUNT_THRESHOLD) reasons.push("multiple_files_changed");

  const risk: HarnessRisk = riskReasons.length > 0 || input.hasDestructiveAction ? "high" : "low";
  const confidence = category && !hasMixedSpecialistImplementationIntent ? "high" : "low";
  const taskType = hasMixedSpecialistImplementationIntent
    ? "unknown"
    : (category?.taskType ?? "unknown");

  if (!category) reasons.push("insufficient_task_signal");

  const result: HarnessTaskClassification = {
    taskType,
    complexity,
    risk,
    confidence,
    reasons,
  };

  if (complexity === "simple") return result;
  if (confidence === "high" && category?.role) result.suggestedRole = category.role;
  return result;
}
