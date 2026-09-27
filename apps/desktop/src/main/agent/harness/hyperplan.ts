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
  HyperPlanSummary,
  PlanSpec,
} from "../../../shared/contracts";
import { getDefaultModel, getModelRegistry } from "../model-service";

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

const CRITIC_TIMEOUT_MS = 60_000;
const SYNTHESIS_TIMEOUT_MS = 45_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_CRITIC_INPUT_BYTES = 24 * 1024;
const MAX_CRITIC_PLAN_BYTES = 12 * 1024;
const MAX_SYNTHESIS_INPUT_BYTES = 24 * 1024;
const MAX_CRITIC_OUTPUT_BYTES = 6 * 1024;
const MAX_SYNTHESIS_OUTPUT_BYTES = 8 * 1024;
const MAX_SUMMARY_BYTES = 32 * 1024;

let reviewActive = false;
let reviewQuarantined = false;
let reviewReturned = false;
let outstandingOperations = 0;
let reviewTimedOut = false;

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
    agreements: z.array(z.string().trim().min(1).max(500)).max(12),
    disagreements: z.array(z.string().trim().min(1).max(500)).max(12),
    risks: z.array(z.string().trim().min(1).max(500)).max(12),
    openQuestions: z.array(z.string().trim().min(1).max(500)).max(12),
    references: z.array(z.string().trim().min(1).max(240)).max(20),
  })
  .strict();

type CriticOutput = z.infer<typeof criticOutputSchema>;
type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;
type IsolatedSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

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
  let planContent = input.planContent;
  let prompt = `${prefix}${JSON.stringify({ planContent, spec })}`;
  while (Buffer.byteLength(prompt, "utf8") > MAX_CRITIC_INPUT_BYTES && planContent.length > 0) {
    const excess = Buffer.byteLength(prompt, "utf8") - MAX_CRITIC_INPUT_BYTES;
    planContent = capUtf8(
      planContent,
      Math.max(0, Buffer.byteLength(planContent, "utf8") - excess - 8),
    );
    prompt = `${prefix}${JSON.stringify({ planContent, spec })}`;
  }
  return Buffer.byteLength(prompt, "utf8") <= MAX_CRITIC_INPUT_BYTES ? prompt : "";
}

function synthesisPrompt(critiques: HyperPlanCriticResult[]): string {
  const structured = critiques.map((critique) => ({
    critic: critique.critic,
    status: critique.status,
    findings: critique.findings.slice(0, 6).map((finding) => capUtf8(finding, 250)),
    references: critique.references.slice(0, 8).map((reference) => capUtf8(reference, 120)),
  }));
  const prefix =
    "SYNTHESIS_INPUT: Synthesize only these capped structured critic results. Unavailable critics are not approvals. Do not infer agreement from missing results. Return ONLY JSON with agreements, disagreements, risks, openQuestions, references arrays (max 12 strings <=500 chars per text, max 20 references <=240 chars).\n";
  let prompt = `${prefix}${JSON.stringify(structured)}`;
  while (Buffer.byteLength(prompt, "utf8") > MAX_SYNTHESIS_INPUT_BYTES) {
    const last = structured.at(-1);
    if (!last) return "";
    if (last.findings.length > 0) last.findings.pop();
    else if (last.references.length > 0) last.references.pop();
    else structured.pop();
    prompt = `${prefix}${JSON.stringify(structured)}`;
  }
  return prompt;
}

async function createIsolatedSession(): Promise<{
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
    const model = getDefaultModel();
    if (!model) throw new Error("No model available.");
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

async function settleAbort(abort: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), CLEANUP_TIMEOUT_MS);
  });
  const settled = abort.then(
    () => true,
    () => false,
  );
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

async function runBoundedPrompt(
  prompt: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string | undefined> {
  if (!prompt) return undefined;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let taskSettled = false;
  let timeoutAbort = (): Promise<void> | undefined => undefined;
  let timeoutCleanup = (): void => {};
  const timeout = new Promise<undefined>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reviewTimedOut = true;
      const aborting = timeoutAbort();
      if (aborting) {
        void settleAbort(aborting).then((settled) => {
          if (!settled) reviewQuarantined = true;
        });
      }
      timeoutCleanup();
      resolve(undefined);
    }, timeoutMs);
  });
  outstandingOperations += 1;
  const operation = (async (): Promise<string | undefined> => {
    let tempDir: string | undefined;
    let session: IsolatedSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let overflowed = false;
    let abortPromise: Promise<void> | undefined;
    let output = "";
    let response: string | undefined;
    let cleanupSucceeded = true;
    const requestAbort = (): Promise<void> | undefined => {
      if (!session || abortPromise) return abortPromise;
      try {
        abortPromise = session.abort();
      } catch {
        cleanupSucceeded = false;
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
      } catch {
        reviewQuarantined = true;
      }
      try {
        session?.dispose();
      } catch {
        reviewQuarantined = true;
      }
      try {
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      } catch {
        reviewQuarantined = true;
      }
    };
    try {
      const created = await createIsolatedSession();
      session = created.session;
      tempDir = created.tempDir;
      if (timedOut) return undefined;
      response = await new Promise<string | undefined>((resolve) => {
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
          .then(() => resolve(overflowed ? undefined : output))
          .catch(() => resolve(undefined));
      });
    } catch {
      response = undefined;
    } finally {
      try {
        unsubscribe?.();
      } catch {
        cleanupSucceeded = false;
      }
      if (session) {
        requestAbort();
        if (abortPromise) {
          cleanupSucceeded = (await settleAbort(abortPromise)) && cleanupSucceeded;
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
    if (!cleanupSucceeded) reviewQuarantined = true;
    if (!cleanupSucceeded || timedOut || overflowed) return undefined;
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
    return undefined;
  }
  if (!taskSettled) return undefined;
  return result;
}

function parseCritique(id: HyperPlanCriticId, raw: string | undefined): HyperPlanCriticResult {
  if (!raw) return { critic: id, status: "unavailable", findings: [], references: [] };
  try {
    const result: CriticOutput = criticOutputSchema.parse(JSON.parse(raw));
    return { critic: id, status: "completed", ...result };
  } catch {
    return { critic: id, status: "unavailable", findings: [], references: [] };
  }
}

function parseSynthesis(raw: string | undefined): SynthesisOutput | undefined {
  if (!raw) return undefined;
  try {
    return synthesisOutputSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function capSummary(summary: HyperPlanSummary): HyperPlanSummary {
  const result: HyperPlanSummary = {
    critiques: summary.critiques.map((critique) => ({
      critic: critique.critic,
      status: critique.status,
      findings: critique.findings.slice(0, 12).map((item) => capUtf8(item, 500)),
      references: critique.references.slice(0, 20).map((item) => capUtf8(item, 240)),
    })),
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

export async function runHyperPlanReview(input: {
  planContent: string;
  spec: PlanSpec;
}): Promise<HyperPlanSummary> {
  if (reviewActive || reviewQuarantined) throw new Error("HyperPlan review busy");
  reviewActive = true;
  reviewReturned = false;
  reviewTimedOut = false;
  const critiques: HyperPlanCriticResult[] = [];
  const boundedInput = {
    ...input,
    planContent: capUtf8(input.planContent, MAX_CRITIC_PLAN_BYTES),
  };
  const criticRuns = CRITICS.map(async ({ id, prompt }) => {
    let raw: string | undefined;
    try {
      raw = await runBoundedPrompt(
        criticPrompt(id, prompt, boundedInput),
        CRITIC_TIMEOUT_MS,
        MAX_CRITIC_OUTPUT_BYTES,
      );
    } catch {
      raw = undefined;
    }
    const result = parseCritique(id, raw);
    critiques.push(result);
  });
  await Promise.all(criticRuns);

  const completedCritiques = critiques.filter((critique) => critique.status === "completed");
  let synthesis: SynthesisOutput | undefined;
  try {
    if (completedCritiques.length === 0 || reviewTimedOut || reviewQuarantined) throw new Error();
    synthesis = parseSynthesis(
      await runBoundedPrompt(
        synthesisPrompt(completedCritiques),
        SYNTHESIS_TIMEOUT_MS,
        MAX_SYNTHESIS_OUTPUT_BYTES,
      ),
    );
  } catch {
    synthesis = undefined;
  }
  const summary: HyperPlanSummary = synthesis
    ? {
        critiques,
        ...synthesis,
        agreements:
          completedCritiques.length < 2
            ? []
            : synthesis.agreements.map((item) => capUtf8(`Among completed critics: ${item}`, 500)),
        disagreements:
          completedCritiques.length < 2
            ? []
            : synthesis.disagreements.map((item) =>
                capUtf8(`Among completed critics: ${item}`, 500),
              ),
      }
    : completedCritiques.length === 0
      ? {
          critiques,
          agreements: [],
          disagreements: [],
          risks: [],
          openQuestions: [
            "No synthesis was performed because no critics completed; no approval was established.",
          ],
          references: [],
        }
      : {
          critiques,
          agreements: [],
          disagreements: [],
          risks: [],
          openQuestions: ["HyperPlan synthesis unavailable; no agreement was established."],
          references: [],
        };
  const capped = capSummary(summary);
  reviewReturned = true;
  maybeReleaseReview();
  return capped;
}
