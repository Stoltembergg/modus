import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defaultBuiltinSkillsDir } from "../skills/skills-config";
import { getAgentSessionGoalJson, setAgentSessionGoalJson } from "./agent-store";

/**
 * define-goal skill state. A session holds at most one goal (no history) in
 * `agent_sessions.goal_json`, plus an `active` flag: once the skill is used in a
 * session its goal tools stay exposed for the rest of that session.
 */
export type SessionGoal = {
  objective: string;
  doneWhen: string[];
  outOfScope: string[];
  stopAndAsk: string[];
  status: "active" | "completed";
  createdAt: string;
  completedAt?: string;
  evidence?: string[];
  summary?: string;
};

export type SessionGoalState = { active: boolean; goal?: SessionGoal };

export const DEFINE_GOAL_SKILL_NAME = "define-goal";

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseGoal(value: unknown): SessionGoal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.objective !== "string" || typeof raw.createdAt !== "string") return undefined;
  const goal: SessionGoal = {
    objective: raw.objective,
    doneWhen: strings(raw.doneWhen),
    outOfScope: strings(raw.outOfScope),
    stopAndAsk: strings(raw.stopAndAsk),
    status: raw.status === "completed" ? "completed" : "active",
    createdAt: raw.createdAt,
  };
  if (typeof raw.completedAt === "string") goal.completedAt = raw.completedAt;
  if (Array.isArray(raw.evidence)) goal.evidence = strings(raw.evidence);
  if (typeof raw.summary === "string") goal.summary = raw.summary;
  return goal;
}

/** The session's goal state; a missing, unreadable or malformed value is inactive. */
export function getSessionGoalState(sessionId: string): SessionGoalState {
  let text: string | undefined;
  try {
    text = getAgentSessionGoalJson(sessionId);
  } catch {
    return { active: false };
  }
  if (!text) return { active: false };
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const goal = parseGoal(raw?.goal);
    return { active: raw?.active === true || goal !== undefined, ...(goal ? { goal } : {}) };
  } catch {
    return { active: false };
  }
}

function writeState(sessionId: string, state: SessionGoalState): void {
  setAgentSessionGoalJson(sessionId, JSON.stringify(state));
}

/** Whether the session's goal tools are exposed: the skill was used or a goal is saved. */
export function goalToolsActive(sessionId: string): boolean {
  return getSessionGoalState(sessionId).active;
}

/** Marks the skill used in this session (idempotent, never undone). Best-effort. */
export function activateGoalTools(sessionId: string): boolean {
  try {
    const state = getSessionGoalState(sessionId);
    if (state.active) return false;
    writeState(sessionId, { ...state, active: true });
    return true;
  } catch {
    return false;
  }
}

export type CreateGoalInput = {
  objective: string;
  doneWhen: string[];
  outOfScope?: string[];
  stopAndAsk?: string[];
};

/** Creates the session goal; refuses while an active goal exists (a completed one is replaced). */
export function createSessionGoal(
  sessionId: string,
  input: CreateGoalInput,
  now: Date = new Date(),
): SessionGoal {
  const objective = input.objective.trim();
  const doneWhen = input.doneWhen.map((item) => item.trim()).filter(Boolean);
  if (!objective) throw new Error("create_goal needs a non-empty objective.");
  if (doneWhen.length === 0) {
    throw new Error("create_goal needs at least one done_when criterion.");
  }
  const state = getSessionGoalState(sessionId);
  if (state.goal?.status === "active") {
    throw new Error(
      "This session already has an active goal. Continue it, complete it with complete_goal, or start a new session for a separate goal.",
    );
  }
  const goal: SessionGoal = {
    objective,
    doneWhen,
    outOfScope: (input.outOfScope ?? []).map((item) => item.trim()).filter(Boolean),
    stopAndAsk: (input.stopAndAsk ?? []).map((item) => item.trim()).filter(Boolean),
    status: "active",
    createdAt: now.toISOString(),
  };
  writeState(sessionId, { active: true, goal });
  return goal;
}

/** Marks the session goal completed with its evidence; refuses without an active goal. */
export function completeSessionGoal(
  sessionId: string,
  input: { evidence: string[]; summary: string },
  now: Date = new Date(),
): SessionGoal {
  const evidence = input.evidence.map((item) => item.trim()).filter(Boolean);
  const summary = input.summary.trim();
  if (evidence.length === 0) throw new Error("complete_goal needs at least one evidence item.");
  if (!summary) throw new Error("complete_goal needs a non-empty summary.");
  const state = getSessionGoalState(sessionId);
  if (!state.goal) throw new Error("This session has no goal to complete. Create one first.");
  if (state.goal.status === "completed") {
    throw new Error("This session's goal is already completed.");
  }
  const goal: SessionGoal = {
    ...state.goal,
    status: "completed",
    completedAt: now.toISOString(),
    evidence,
    summary,
  };
  writeState(sessionId, { active: true, goal });
  return goal;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Absolute path of the built-in define-goal SKILL.md (listed in the skills manifest). */
export function builtinDefineGoalSkillPath(): string {
  return join(defaultBuiltinSkillsDir(), DEFINE_GOAL_SKILL_NAME, "SKILL.md");
}

/** Whether a `read` tool path (relative to `cwd`, `~` allowed) is the built-in define-goal skill. */
export function isBuiltinDefineGoalSkillRead(
  path: unknown,
  cwd: string,
  skillPath: string = builtinDefineGoalSkillPath(),
): boolean {
  if (typeof path !== "string" || !path.trim()) return false;
  let target = path.trim();
  if (target === "~" || target.startsWith("~/")) target = join(homedir(), target.slice(1));
  const absolute = isAbsolute(target) ? target : resolve(cwd, target);
  return canonicalPath(absolute) === canonicalPath(skillPath);
}

/** Whether a turn's rendered skills text invoked define-goal via `<invoked_skills>`. */
export function invokedDefineGoalSkill(skillsText: string): boolean {
  if (!skillsText.includes("<invoked_skills>")) return false;
  return skillsText.includes(`<skill name="${DEFINE_GOAL_SKILL_NAME}" path="`);
}
