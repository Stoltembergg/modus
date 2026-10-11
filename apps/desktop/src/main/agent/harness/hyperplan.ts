import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadExtensionsResult, ResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type {
  HyperPlanCriticId,
  HyperPlanCriticResult,
  HyperPlanReviewInput,
  HyperPlanRevision,
  HyperPlanSummary,
  PlanSpec,
} from "../../../shared/contracts";
import { findModel, getDefaultModel, getModelRegistry, isUsableModelId } from "../model-service";

const CRITICS: Array<{ id: HyperPlanCriticId; prompt: string }> = [
  {
    id: "architecture",
    prompt:
      "Review the requirements, interfaces, dependencies, and sequencing for architectural gaps.",
  },
  {
    id: "risk",
    prompt:
      "Review security, data-loss, compatibility, and operational risks; identify unsupported assumptions.",
  },
  {
    id: "simplicity",
    prompt:
      "Review for unnecessary complexity, duplication, and YAGNI; suggest simpler viable alternatives.",
  },
  {
    id: "failure",
    prompt:
      "Review failure modes and whether acceptance criteria and verification steps are observable and sufficient.",
  },
];

const SESSION_SETUP_TIMEOUT_MS = 60_000;
const CRITIC_TIMEOUT_MS = 5 * 60_000;
const SYNTHESIS_TIMEOUT_MS = 45_000;
const REVISION_TIMEOUT_MS = 5 * 60_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_CRITIC_INPUT_BYTES = 24 * 1024;
const MAX_CRITIC_PLAN_BYTES = 12 * 1024;
const MAX_SYNTHESIS_INPUT_BYTES = 24 * 1024;
const MAX_CRITIC_OUTPUT_BYTES = 6 * 1024;
const MAX_SYNTHESIS_OUTPUT_BYTES = 20 * 1024;
const MAX_SUMMARY_BYTES = 32 * 1024;
const MAX_REVISED_CONTENT_BYTES = 12 * 1024;
const MAX_REVISION_INPUT_BYTES = 256 * 1024;
const MAX_REVISION_OUTPUT_BYTES = 128 * 1024;

let reviewActive = false;
let reviewQuarantined = false;
let reviewReturned = false;
let outstandingOperations = 0;
let reviewTimedOut = false;
let reviewQuarantineMessage: string | undefined;
let timeoutCleanupPromises: Promise<void>[] = [];

function maybeReleaseReview(): void {
  if (reviewReturned && outstandingOperations === 0 && !reviewQuarantined) {
    reviewActive = false;
    reviewReturned = false;
  }
}

const criticOutputSchema = z
  .object({
    findings: z.array(z.string().trim().min(1).max(500)).max(12),
    references: z.array(z.string().trim().min(1).max(240)).max(20),
  })
  .strict();

const synthesisOutputSchema = z
  .object({
    revisedContent: z.string().trim().min(1).max(MAX_REVISED_CONTENT_BYTES),
    agreements: z.array(z.string().trim().min(1).max(500)).max(12),
    disagreements: z.array(z.string().trim().min(1).max(500)).max(12),
    risks: z.array(z.string().trim().min(1).max(500)).max(12),
    openQuestions: z.array(z.string().trim().min(1).max(500)).max(12),
    references: z.array(z.string().trim().min(1).max(240)).max(20),
  })
  .strict();

type CriticOutput = z.infer<typeof criticOutputSchema>;
type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;
const revisionOutputSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    overview: z.string().trim().min(1).max(2_000),
    content: z.string().trim().min(1).max(100_000),
    todos: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            content: z.string().trim().min(1).max(2_000),
            acceptanceCriterionIds: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    spec: z
      .object({
        requirements: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).max(120),
                text: z.string().trim().min(1).max(2_000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        acceptanceCriteria: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).max(120),
                requirementId: z.string().trim().min(1).max(120),
                description: z.string().trim().min(1).max(2_000),
                todoIds: z.array(z.string().trim().min(1).max(120)).max(100),
                requiredCheckKinds: z
                  .array(z.enum(["tests", "typecheck", "lint", "build"]))
                  .max(4)
                  .optional(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        assumptions: z.array(z.string().trim().min(1).max(2_000)).max(100),
        openQuestions: z.array(z.string().trim().min(1).max(2_000)).max(100),
      })
      .strict(),
  })
  .strict();
type RevisionOutput = z.infer<typeof revisionOutputSchema>;
type IsolatedSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type FailureReason =
  | "session_setup_failure"
  | "prompt_failure"
  | "timeout"
  | "output_limit"
  | "cleanup_failure"
  | "invalid_synthesis_output"
  | "empty_synthesis_output"
  | "critic_timeout"
  | "critic_quarantine";
type PromptResult = { output?: string; reason?: FailureReason; message?: string };

export class HyperPlanReviewFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
    this.name = "HyperPlanReviewFailure";
  }
}

/** Fixed copy shown in the review-error UI — never interpolates raw provider/path text. */
const USER_FACING_BY_REASON: Record<FailureReason, string> = {
  session_setup_failure:
    "No model available for HyperPlan review. Choose a model in Spec and try again.",
  prompt_failure:
    "The model could not complete HyperPlan review. Try again or build the original plan.",
  timeout: "HyperPlan review timed out. Try again or build the original plan.",
  output_limit: "HyperPlan review output was too large. Try again with a shorter plan.",
  cleanup_failure: "HyperPlan review failed during cleanup. Restart Modus if this keeps happening.",
  invalid_synthesis_output: "The model returned invalid review JSON. Try again.",
  empty_synthesis_output: "HyperPlan review produced an empty synthesis. Try again.",
  critic_timeout: "A HyperPlan critic timed out. Try again or build the original plan.",
  critic_quarantine:
    "HyperPlan review is temporarily blocked after a failed cleanup. Restart Modus or try again later.",
};

const GENERIC_USER_FACING =
  "HyperPlan review is unavailable. Try again or build the original plan.";

/**
 * Maps HyperPlan failures to a short, secret-safe message for the renderer.
 * Never forwards raw Error.message (may contain paths or provider details).
 */
export function userFacingHyperPlanMessage(error: unknown): string {
  if (error instanceof HyperPlanReviewFailure) {
    return USER_FACING_BY_REASON[error.reason] ?? GENERIC_USER_FACING;
  }
  const raw = error instanceof Error ? error.message : String(error);
  if (/no model available/i.test(raw)) return USER_FACING_BY_REASON.session_setup_failure;
  if (/review busy|already active/i.test(raw)) {
    return "HyperPlan review is already running. Try again in a moment.";
  }
  if (/size budget|too large|12 KiB/i.test(raw)) {
    return "This plan is too large for HyperPlan review. Shorten it and try again.";
  }
  if (/invalid revision output/i.test(raw)) {
    return "The model returned an invalid revised plan. Try again.";
  }
  if (/changed during|changed since|source changed/i.test(raw)) {
    return "The plan changed during review. Try again.";
  }
  if (/does not belong|spec plan not found|agent session not found/i.test(raw)) {
    return "This plan is not available for HyperPlan review.";
  }
  if (/draft owner|not active/i.test(raw)) {
    return "HyperPlan review is unavailable in this window. Try again.";
  }
  if (/revision unavailable|did not complete/i.test(raw)) {
    return USER_FACING_BY_REASON.prompt_failure;
  }
  return GENERIC_USER_FACING;
}

function capUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    const characterBytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + characterBytes > maxBytes) return text.slice(0, end);
    bytes += characterBytes;
    end += character.length;
  }
  return text;
}

function boundedSpec(spec: PlanSpec): PlanSpec {
  const short = (value: string, limit = 200): string => capUtf8(value, limit);
  return {
    requirements: spec.requirements.slice(0, 6).map((item) => ({
      id: short(item.id, 80),
      text: short(item.text),
    })),
    acceptanceCriteria: spec.acceptanceCriteria.slice(0, 6).map((item) => ({
      id: short(item.id, 80),
      requirementId: short(item.requirementId, 80),
      description: short(item.description),
      todoIds: item.todoIds.slice(0, 4).map((id) => short(id, 80)),
      ...(item.requiredCheckKinds
        ? { requiredCheckKinds: item.requiredCheckKinds.slice(0, 4) }
        : {}),
      status: item.status,
    })),
    evidence: spec.evidence.slice(0, 6).map((item) => ({
      id: short(item.id, 80),
      criterionId: short(item.criterionId, 80),
      kind: short(item.kind, 80),
      status: item.status,
      ...(item.runId ? { runId: short(item.runId, 80) } : {}),
      ...(item.eventId ? { eventId: short(item.eventId, 80) } : {}),
      ...(item.revision ? { revision: short(item.revision, 80) } : {}),
      ...(item.paths ? { paths: item.paths.slice(0, 2).map((path) => short(path, 100)) } : {}),
      label: short(item.label, 160),
    })),
    assumptions: spec.assumptions.slice(0, 8).map((item) => short(item)),
    openQuestions: spec.openQuestions.slice(0, 8).map((item) => short(item)),
  };
}

function criticPrompt(
  id: HyperPlanCriticId,
  instruction: string,
  input: { planContent: string; spec: PlanSpec },
): string {
  const prefix = `CRITIC_ID: ${id}\n${instruction}\nReview only the bounded structured Spec and plan below. Do not invent evidence or mark criteria complete. Return ONLY JSON: {"findings":["..."],"references":["..."]}. Findings max 12, each <=500 characters; references max 20, each <=240 characters.\nSPEC_AND_PLAN_INPUT:\n`;
  const spec = boundedSpec(input.spec);
  const prompt = `${prefix}${JSON.stringify({ planContent: input.planContent, spec })}`;
  return Buffer.byteLength(prompt, "utf8") <= MAX_CRITIC_INPUT_BYTES ? prompt : "";
}

function synthesisPrompt(input: {
  planContent: string;
  spec: PlanSpec;
  critiques: HyperPlanCriticResult[];
}): string {
  const critiques = input.critiques;
  const structured = critiques.map((critique) => ({
    critic: critique.critic,
    status: critique.status,
    findings: critique.findings.slice(0, 6).map((finding) => capUtf8(finding, 250)),
    references: critique.references.slice(0, 8).map((reference) => capUtf8(reference, 120)),
  }));
  const source = {
    planContent: input.planContent,
    spec: boundedSpec(input.spec),
    critiques: structured,
  };
  const prefix =
    "SYNTHESIS_INPUT: Revise the supplied plan using its Spec and only these completed critic results. Preserve the plan's intent and do not invent evidence. Unavailable critics are not approvals. Return ONLY JSON with revisedContent (non-empty Markdown <=12 KiB), agreements, disagreements, risks, openQuestions, references arrays (max 12 strings <=500 chars per text, max 20 references <=240 chars).\n";
  let prompt = `${prefix}${JSON.stringify(source)}`;
  while (Buffer.byteLength(prompt, "utf8") > MAX_SYNTHESIS_INPUT_BYTES) {
    const lastWithFindings = [...source.critiques]
      .reverse()
      .find((critic) => critic.findings.length);
    const lastWithReferences = [...source.critiques]
      .reverse()
      .find((critic) => critic.references.length);
    if (lastWithFindings) lastWithFindings.findings.pop();
    else if (lastWithReferences) lastWithReferences.references.pop();
    else return "";
    prompt = `${prefix}${JSON.stringify(source)}`;
  }
  return prompt;
}

function revisionPrompt(input: HyperPlanReviewInput, synthesis: SynthesisOutput): string {
  const source = JSON.stringify({
    title: input.title,
    overview: input.overview,
    content: input.content,
    todos: input.todos,
    spec: input.spec,
  });
  const feedback = JSON.stringify(synthesis);
  const prefix =
    "REVISION_INPUT: Rewrite this plan as a complete actionable plan, preserving valid requirements and addressing bounded review feedback. Return ONLY strict JSON with title, overview, content, todos [{id,content,acceptanceCriterionIds}], and spec {requirements [{id,text}], acceptanceCriteria [{id,requirementId,description,todoIds,requiredCheckKinds?}], assumptions, openQuestions}. Do not include todo/criterion status or evidence. IDs must be unique and every link must target an included ID.\nSYNTHESIS_FEEDBACK:\n";
  const suffix = "\nSOURCE_PLAN:\n";
  const prompt = `${prefix}${feedback}${suffix}${source}`;
  return Buffer.byteLength(prompt, "utf8") <= MAX_REVISION_INPUT_BYTES ? prompt : "";
}

function parseRevision(raw: string | undefined): HyperPlanRevision | undefined {
  if (!raw) return undefined;
  try {
    if (Buffer.byteLength(raw, "utf8") > MAX_REVISION_OUTPUT_BYTES) return undefined;
    const revision: RevisionOutput = revisionOutputSchema.parse(JSON.parse(raw));
    const unique = (ids: string[]): boolean => new Set(ids).size === ids.length;
    const todoIds = revision.todos.map((todo) => todo.id);
    const requirementIds = revision.spec.requirements.map((requirement) => requirement.id);
    const criterionIds = revision.spec.acceptanceCriteria.map((criterion) => criterion.id);
    if (!unique(todoIds) || !unique(requirementIds) || !unique(criterionIds)) return undefined;
    const todoIdSet = new Set(todoIds);
    const requirementIdSet = new Set(requirementIds);
    const criterionIdSet = new Set(criterionIds);
    if (
      revision.todos.some((todo) =>
        (todo.acceptanceCriterionIds ?? []).some((id) => !criterionIdSet.has(id)),
      ) ||
      revision.spec.acceptanceCriteria.some(
        (criterion) =>
          !requirementIdSet.has(criterion.requirementId) ||
          criterion.todoIds.some((id) => !todoIdSet.has(id)),
      )
    ) {
      return undefined;
    }
    return {
      title: revision.title,
      overview: revision.overview,
      content: revision.content,
      todos: revision.todos.map(({ id, content, acceptanceCriterionIds }) => ({
        id,
        content,
        ...(acceptanceCriterionIds ? { acceptanceCriterionIds } : {}),
      })),
      spec: {
        requirements: revision.spec.requirements,
        acceptanceCriteria: revision.spec.acceptanceCriteria.map(
          ({ id, requirementId, description, todoIds, requiredCheckKinds }) => ({
            id,
            requirementId,
            description,
            todoIds,
            ...(requiredCheckKinds ? { requiredCheckKinds } : {}),
          }),
        ),
        assumptions: revision.spec.assumptions,
        openQuestions: revision.spec.openQuestions,
      },
    };
  } catch {
    return undefined;
  }
}

async function createIsolatedSession(modelId?: string): Promise<{
  session: IsolatedSession;
  tempDir: string;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "modus-hyperplan-"));
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const extensions: LoadExtensionsResult = {
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    };
    const resourceLoader: ResourceLoader = {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "",
      getAppendSystemPrompt: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const modelRegistry = getModelRegistry();
    // Prefer the Spec/session/composer model exactly; use Settings only when none was chosen.
    const model = modelId === undefined ? getDefaultModel() : findModel(modelId);
    if (!model || (modelId !== undefined && !isUsableModelId(modelId))) {
      if (modelId !== undefined) throw new Error(`Selected model is unavailable: ${modelId}`);
      throw new Error("No model available.");
    }
    const { session } = await createAgentSession({
      cwd: tempDir,
      agentDir: tempDir,
      model,
      authStorage: modelRegistry.authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      tools: [],
      customTools: [],
      noTools: "all",
    });
    return { session, tempDir };
  } catch (error) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      reviewQuarantined = true;
    }
    throw error;
  }
}

async function settleAbort(abort: Promise<void>): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("Session cleanup timed out."), CLEANUP_TIMEOUT_MS);
  });
  const settled = abort.then(
    () => undefined,
    (error: unknown) => `Session abort failed: ${failureMessage(error)}`,
  );
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

async function runBoundedPrompt(
  prompt: string,
  timeoutMs: number,
  maxOutputBytes: number,
  modelId?: string,
): Promise<PromptResult> {
  if (!prompt) {
    return {
      reason: "prompt_failure",
      message: "The complete prompt exceeded its bounded input limit.",
    };
  }
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let taskSettled = false;
  let timeoutAbort = (): Promise<void> | undefined => undefined;
  let timeoutCleanup = (): void => {};
  let resolveTimeout: ((result: PromptResult) => void) | undefined;
  const onTimeout = (): void => {
    if (timedOut) return;
    timedOut = true;
    reviewTimedOut = true;
    const aborting = timeoutAbort();
    if (aborting) {
      const cleanup = settleAbort(aborting).then((settled) => {
        if (settled) reviewQuarantined = true;
      });
      timeoutCleanupPromises.push(cleanup);
    }
    timeoutCleanup();
    resolveTimeout?.({ reason: "timeout" });
  };
  const timeout = new Promise<PromptResult>((resolve) => {
    resolveTimeout = resolve;
  });
  const armTimeout = (durationMs: number): void => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(onTimeout, durationMs);
  };
  armTimeout(SESSION_SETUP_TIMEOUT_MS);
  outstandingOperations += 1;
  const operation = (async (): Promise<PromptResult> => {
    let tempDir: string | undefined;
    let session: IsolatedSession | undefined;
    let sessionCreated = false;
    let unsubscribe: (() => void) | undefined;
    let overflowed = false;
    let abortPromise: Promise<void> | undefined;
    let output = "";
    let response: PromptResult = {
      reason: "session_setup_failure",
      message: "Session setup did not complete.",
    };
    let cleanupSucceeded = true;
    let cleanupFailure: string | undefined;
    const requestAbort = (): Promise<void> | undefined => {
      if (!session || abortPromise) return abortPromise;
      try {
        abortPromise = session.abort();
      } catch (error) {
        cleanupSucceeded = false;
        cleanupFailure = `Session abort failed: ${failureMessage(error)}`;
        reviewQuarantined = true;
        reviewQuarantineMessage = cleanupFailure;
      }
      return abortPromise;
    };
    timeoutAbort = requestAbort;
    let timeoutCleaned = false;
    timeoutCleanup = () => {
      if (timeoutCleaned || (!session && !tempDir)) return;
      timeoutCleaned = true;
      try {
        unsubscribe?.();
      } catch (error) {
        cleanupFailure = `Session unsubscribe failed: ${failureMessage(error)}`;
        cleanupSucceeded = false;
        reviewQuarantined = true;
      }
      try {
        session?.dispose();
      } catch (error) {
        cleanupFailure = `Session disposal failed: ${failureMessage(error)}`;
        cleanupSucceeded = false;
        reviewQuarantined = true;
      }
      try {
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      } catch (error) {
        cleanupFailure = `Session directory cleanup failed: ${failureMessage(error)}`;
        cleanupSucceeded = false;
        reviewQuarantined = true;
      }
    };
    try {
      const created = await createIsolatedSession(modelId);
      session = created.session;
      tempDir = created.tempDir;
      sessionCreated = true;
      if (timedOut) return { reason: "timeout" };
      armTimeout(timeoutMs);
      response = await new Promise<PromptResult>((resolve) => {
        unsubscribe = session?.subscribe((event) => {
          if (
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "message_update" &&
            "assistantMessageEvent" in event &&
            typeof event.assistantMessageEvent === "object" &&
            event.assistantMessageEvent !== null &&
            "type" in event.assistantMessageEvent &&
            event.assistantMessageEvent.type === "text_delta" &&
            "delta" in event.assistantMessageEvent &&
            typeof event.assistantMessageEvent.delta === "string"
          ) {
            const next = output + event.assistantMessageEvent.delta;
            if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
              overflowed = true;
              requestAbort();
            } else {
              output = next;
            }
          }
        });
        void session
          ?.prompt(prompt, { source: "rpc" })
          .then(() =>
            resolve(
              overflowed
                ? {
                    reason: "output_limit",
                    message: `Prompt output exceeded ${maxOutputBytes} bytes.`,
                  }
                : { output },
            ),
          )
          .catch((error: unknown) =>
            resolve({
              reason: "prompt_failure",
              message: `Session prompt failed: ${failureMessage(error)}`,
            }),
          );
      });
    } catch (error) {
      response = {
        reason: sessionCreated ? "prompt_failure" : "session_setup_failure",
        message: `${sessionCreated ? "Session prompt failed" : "Session setup failed"}: ${failureMessage(error)}`,
      };
    } finally {
      try {
        unsubscribe?.();
      } catch (error) {
        cleanupFailure = `Session unsubscribe failed: ${failureMessage(error)}`;
        cleanupSucceeded = false;
      }
      if (session) {
        requestAbort();
        if (abortPromise) {
          const cleanupError = await settleAbort(abortPromise);
          if (cleanupError) {
            cleanupFailure = cleanupFailure ?? cleanupError;
            cleanupSucceeded = false;
          }
        } else {
          cleanupSucceeded = false;
        }
        try {
          session.dispose();
        } catch {
          cleanupSucceeded = false;
        }
      }
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          cleanupSucceeded = false;
        }
      }
    }
    if (!cleanupSucceeded) {
      reviewQuarantined = true;
      return {
        reason: "cleanup_failure",
        message: cleanupFailure ?? "Session cleanup failed.",
      };
    }
    if (timedOut) {
      return {
        reason: "timeout",
        message: `Prompt timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
      };
    }
    if (overflowed) {
      return {
        reason: "output_limit",
        message: `Prompt output exceeded ${maxOutputBytes} bytes.`,
      };
    }
    return response;
  })();
  const trackedOperation = operation.finally(() => {
    taskSettled = true;
    outstandingOperations -= 1;
    maybeReleaseReview();
  });
  const result = await Promise.race([trackedOperation, timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (timedOut) {
    // The worker remains counted until its in-flight model/session work and cleanup settle.
    return {
      reason: "timeout",
      message: `Prompt timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
    };
  }
  if (!taskSettled) {
    return { reason: "timeout", message: "Session operation did not settle before its deadline." };
  }
  return result;
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = capUtf8(message.trim() || "Unknown failure.", 400);
  return bounded.replace(/[\r\n\t]+/g, " ");
}

function parseCritique(
  id: HyperPlanCriticId,
  promptResult: PromptResult,
): { result: HyperPlanCriticResult; failure?: { reason: FailureReason; message: string } } {
  if (promptResult.reason) {
    return {
      result: { critic: id, status: "unavailable", findings: [], references: [] },
      failure: {
        reason: promptResult.reason,
        message: promptResult.message ?? `Critic failed with ${promptResult.reason}.`,
      },
    };
  }
  if (!promptResult.output?.trim()) {
    return {
      result: { critic: id, status: "unavailable", findings: [], references: [] },
      failure: { reason: "prompt_failure", message: "Critic returned no output." },
    };
  }
  try {
    const result: CriticOutput = criticOutputSchema.parse(JSON.parse(promptResult.output));
    return { result: { critic: id, status: "completed", ...result } };
  } catch {
    return {
      result: { critic: id, status: "unavailable", findings: [], references: [] },
      failure: {
        reason: "prompt_failure",
        message: "Critic returned invalid JSON or an invalid response.",
      },
    };
  }
}

function parseSynthesis(promptResult: PromptResult): SynthesisOutput {
  if (promptResult.reason) {
    throw new HyperPlanReviewFailure(
      promptResult.reason,
      promptResult.message ?? `Synthesis failed with ${promptResult.reason}.`,
    );
  }
  if (!promptResult.output?.trim()) {
    throw new HyperPlanReviewFailure("empty_synthesis_output", "Synthesis returned no output.");
  }
  try {
    const result = synthesisOutputSchema.parse(JSON.parse(promptResult.output));
    if (Buffer.byteLength(result.revisedContent, "utf8") > MAX_REVISED_CONTENT_BYTES) {
      throw new HyperPlanReviewFailure(
        "invalid_synthesis_output",
        `Revised Markdown exceeds ${MAX_REVISED_CONTENT_BYTES} bytes.`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof HyperPlanReviewFailure) throw error;
    throw new HyperPlanReviewFailure(
      "invalid_synthesis_output",
      "Synthesis returned invalid JSON or an invalid revised Markdown body.",
    );
  }
}

function logSynthesisFailure(reason: FailureReason): void {
  console.warn(`[HyperPlan] stage=synthesis reason=${reason}`);
}

function capSummary(summary: HyperPlanSummary): HyperPlanSummary {
  const result: HyperPlanSummary = {
    critiques: summary.critiques.map((critique) => ({
      critic: critique.critic,
      status: critique.status,
      findings: critique.findings.slice(0, 12).map((item) => capUtf8(item, 500)),
      references: critique.references.slice(0, 20).map((item) => capUtf8(item, 240)),
    })),
    revisedContent: capUtf8(summary.revisedContent, MAX_REVISED_CONTENT_BYTES),
    agreements: summary.agreements.slice(0, 12).map((item) => capUtf8(item, 500)),
    disagreements: summary.disagreements.slice(0, 12).map((item) => capUtf8(item, 500)),
    risks: summary.risks.slice(0, 12).map((item) => capUtf8(item, 500)),
    openQuestions: summary.openQuestions.slice(0, 12).map((item) => capUtf8(item, 500)),
    references: summary.references.slice(0, 20).map((item) => capUtf8(item, 240)),
  };
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SUMMARY_BYTES) {
    const arrays: string[][] = [
      ...result.critiques.map((critique) => critique.references),
      ...result.critiques.map((critique) => critique.findings),
      result.references,
      result.disagreements,
      result.openQuestions,
      result.risks,
      result.agreements,
    ];
    const target = arrays.find((items) => items.length > 0);
    if (!target) break;
    target.pop();
  }
  return result;
}

async function runHyperPlanPipeline(
  input: {
    planContent: string;
    spec: PlanSpec;
    modelId?: string;
  },
  retainAdmission = false,
): Promise<{ summary: HyperPlanSummary; synthesis?: SynthesisOutput }> {
  if (reviewActive || reviewQuarantined) throw new Error("HyperPlan review busy");
  reviewActive = true;
  reviewReturned = false;
  reviewTimedOut = false;
  timeoutCleanupPromises = [];
  const critiques: HyperPlanCriticResult[] = [];
  const criticFailures = new Map<HyperPlanCriticId, string>();
  const criticFailureReasons = new Map<HyperPlanCriticId, FailureReason>();
  const boundedInput = input;
  const modelId = input.modelId;
  let pipelineCompleted = false;
  try {
    const criticRuns = CRITICS.map(async ({ id, prompt }) => {
      let outcome: PromptResult;
      try {
        outcome = await runBoundedPrompt(
          criticPrompt(id, prompt, boundedInput),
          CRITIC_TIMEOUT_MS,
          MAX_CRITIC_OUTPUT_BYTES,
          modelId,
        );
      } catch (error) {
        outcome = {
          reason: "prompt_failure",
          message: `Critic session failed: ${failureMessage(error)}`,
        };
      }
      const { result, failure } = parseCritique(id, outcome);
      critiques.push(result);
      if (failure) {
        criticFailures.set(id, failure.message);
        criticFailureReasons.set(id, failure.reason);
        console.warn(`[HyperPlan] stage=critic reason=${failure.reason} critic=${id}`);
      }
    });
    await Promise.all(criticRuns);
    if (reviewTimedOut) await Promise.all(timeoutCleanupPromises);

    const completedCritiques = critiques.filter((critique) => critique.status === "completed");
    if (reviewTimedOut) {
      console.warn("[HyperPlan] stage=critics reason=critic_timeout");
    }
    if (reviewQuarantined) {
      console.warn("[HyperPlan] stage=critics reason=critic_quarantine");
      throw new HyperPlanReviewFailure(
        "critic_quarantine",
        reviewQuarantineMessage ??
          CRITICS.map(({ id }) => criticFailures.get(id)).find(Boolean) ??
          "A HyperPlan critic timed out or failed cleanup; review is quarantined.",
      );
    }
    if (reviewTimedOut) {
      throw new HyperPlanReviewFailure(
        "critic_timeout",
        CRITICS.map(({ id }) => criticFailures.get(id)).find(Boolean) ??
          "A HyperPlan critic timed out; review synthesis was skipped.",
      );
    }
    if (completedCritiques.length === 0) {
      const reason =
        CRITICS.map(({ id }) => criticFailureReasons.get(id)).find(Boolean) ?? "prompt_failure";
      throw new HyperPlanReviewFailure(
        reason,
        CRITICS.map(({ id }) => criticFailures.get(id)).find(Boolean) ??
          "No critics completed with valid output.",
      );
    }

    if (completedCritiques.length < 2) {
      console.warn(
        "[HyperPlan] stage=critics reason=prompt_failure insufficient_completed_critics",
      );
    }
    let synthesis: SynthesisOutput;
    try {
      const synthesisResult = await runBoundedPrompt(
        synthesisPrompt({ ...boundedInput, critiques: completedCritiques }),
        SYNTHESIS_TIMEOUT_MS,
        MAX_SYNTHESIS_OUTPUT_BYTES,
        modelId,
      );
      synthesis = parseSynthesis(synthesisResult);
    } catch (error) {
      const reason = error instanceof HyperPlanReviewFailure ? error.reason : "prompt_failure";
      logSynthesisFailure(reason);
      throw error;
    }
    const summary: HyperPlanSummary = {
      critiques,
      ...synthesis,
      agreements:
        completedCritiques.length < 2
          ? []
          : synthesis.agreements.map((item) => capUtf8(`Among completed critics: ${item}`, 500)),
      disagreements:
        completedCritiques.length < 2
          ? []
          : synthesis.disagreements.map((item) => capUtf8(`Among completed critics: ${item}`, 500)),
    };
    const capped = capSummary(summary);
    pipelineCompleted = true;
    return { summary: capped, ...(synthesis ? { synthesis } : {}) };
  } catch (error) {
    if (error instanceof HyperPlanReviewFailure) throw error;
    throw new HyperPlanReviewFailure("prompt_failure", failureMessage(error));
  } finally {
    if (!retainAdmission || !pipelineCompleted) {
      reviewReturned = true;
      maybeReleaseReview();
    }
  }
}

export async function runHyperPlanReview(input: {
  planContent: string;
  spec: PlanSpec;
  modelId?: string;
}): Promise<HyperPlanSummary> {
  if (Buffer.byteLength(input.planContent, "utf8") > MAX_CRITIC_PLAN_BYTES) {
    throw new Error("Plan content exceeds the 12 KiB HyperPlan review limit.");
  }
  try {
    return (await runHyperPlanPipeline(input)).summary;
  } catch (error) {
    if (
      error instanceof HyperPlanReviewFailure &&
      error.reason === "critic_timeout" &&
      !reviewQuarantined
    ) {
      return capSummary({
        revisedContent: "",
        critiques: CRITICS.map(({ id }) => ({
          critic: id,
          status: "unavailable" as const,
          findings: [],
          references: [],
        })),
        agreements: [],
        disagreements: [],
        risks: [],
        openQuestions: ["HyperPlan review timed out; no approval was established."],
        references: [],
      });
    }
    throw error;
  }
}

export async function runHyperPlanRevision(
  input: HyperPlanReviewInput,
  options?: { modelId?: string },
): Promise<HyperPlanRevision> {
  const initialPrompt = revisionPrompt(input, {
    revisedContent: "",
    agreements: [],
    disagreements: [],
    risks: [],
    openQuestions: [],
    references: [],
  });
  if (!initialPrompt) throw new Error("HyperPlan revision input exceeds its size budget");

  let admissionAcquired = false;
  const modelId = options?.modelId;
  try {
    const { summary, synthesis } = await runHyperPlanPipeline(
      { planContent: input.content, spec: input.spec, ...(modelId ? { modelId } : {}) },
      true,
    );
    admissionAcquired = true;
    if (!synthesis || !summary.critiques.some((critique) => critique.status === "completed")) {
      throw new Error("HyperPlan revision unavailable: review did not complete");
    }
    const prompt = revisionPrompt(input, synthesis);
    if (!prompt) throw new Error("HyperPlan revision input exceeds its size budget");
    const result = await runBoundedPrompt(
      prompt,
      REVISION_TIMEOUT_MS,
      MAX_REVISION_OUTPUT_BYTES,
      modelId,
    );
    const revision = parseRevision(result.output);
    if (!revision) throw new Error("HyperPlan revision unavailable: invalid revision output");
    return revision;
  } catch (error) {
    if (error instanceof HyperPlanReviewFailure) {
      throw new HyperPlanReviewFailure(
        error.reason,
        `HyperPlan revision unavailable: ${error.message}`,
      );
    }
    throw error;
  } finally {
    if (admissionAcquired) {
      reviewReturned = true;
      maybeReleaseReview();
    }
  }
}
