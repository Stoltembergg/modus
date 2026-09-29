import {
  AGENT_FALLBACK_INSTRUCTIONS,
  AGENT_FALLBACK_ROLE,
  AGENT_GENERATED_INSTRUCTIONS_MAX_CHARS,
  AGENT_GENERATED_ROLE_MAX_CHARS,
  AGENT_GENERATION_WARNING,
} from "../../shared/agent-templates";
import type { GeneratedAgentProfile } from "../../shared/contracts";

/*
 * Role + instructions for a custom agent (A3): ONE call to the agent's chosen
 * model, asked for JSON `{ role, instructions }`. Any failure (provider
 * error, timeout, invalid JSON, empty fields) falls back to "Generalist" and
 * the default instructions, with a warning the dialog shows. The completer is
 * injected, so tests run with a mocked provider.
 */

/** One text completion: system prompt + user prompt → the model's reply text. */
export type ProfileCompleter = (request: {
  modelId: string;
  systemPrompt: string;
  prompt: string;
  signal: AbortSignal;
}) => Promise<string>;

export type AgentProfileRequest = {
  modelId: string;
  name: string;
  description?: string | undefined;
  /** The roles of the group's other members (the new role should complement them). */
  otherRoles: readonly string[];
};

export const AGENT_PROFILE_TIMEOUT_MS = 30_000;

export const AGENT_PROFILE_SYSTEM_PROMPT = [
  "You design one member of a small team of AI coding agents that work together in a group chat.",
  'Reply with ONLY a JSON object: {"role": string, "instructions": string}. No prose, no code fences.',
  `"role" is a short job title (at most ${AGENT_GENERATED_ROLE_MAX_CHARS} characters), e.g. "Reviewer".`,
  `"instructions" is the agent's persona in the second person ("You ..."), plain text, at most ${AGENT_GENERATED_INSTRUCTIONS_MAX_CHARS} characters: what it does, how it works with the others, and what it leaves to them.`,
  "Pick a role that complements the existing members' roles; do not repeat one of them.",
].join("\n");

/** The user prompt: name, optional description and the other members' roles. */
export function buildAgentProfilePrompt(request: AgentProfileRequest): string {
  const roles = request.otherRoles.map((role) => role.trim()).filter(Boolean);
  const description = request.description?.trim();
  return [
    `Agent name: ${request.name.trim()}`,
    description
      ? `What it should help with: ${description}`
      : "What it should help with: (not given)",
    roles.length > 0
      ? `Roles already in the group: ${[...new Set(roles)].join(", ")}`
      : "Roles already in the group: (none yet)",
  ].join("\n");
}

/** The JSON object in a reply (bare, fenced or with text around it); undefined when absent. */
function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/** Valid `{ role, instructions }` (both non-empty strings, cut to their limits), else undefined. */
export function parseAgentProfile(
  text: string,
): { role: string; instructions: string } | undefined {
  const value = extractJsonObject(text);
  if (!value || typeof value !== "object") return undefined;
  const { role, instructions } = value as { role?: unknown; instructions?: unknown };
  if (typeof role !== "string" || typeof instructions !== "string") return undefined;
  const cleanRole = role
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, AGENT_GENERATED_ROLE_MAX_CHARS)
    .trim();
  const cleanInstructions = instructions
    .trim()
    .slice(0, AGENT_GENERATED_INSTRUCTIONS_MAX_CHARS)
    .trim();
  if (!cleanRole || !cleanInstructions) return undefined;
  return { role: cleanRole, instructions: cleanInstructions };
}

export function fallbackAgentProfile(): GeneratedAgentProfile {
  return {
    role: AGENT_FALLBACK_ROLE,
    instructions: AGENT_FALLBACK_INSTRUCTIONS,
    generated: false,
    warning: AGENT_GENERATION_WARNING,
  };
}

/** Generates the profile; never throws (failures return the fallback). */
export async function generateAgentProfile(
  request: AgentProfileRequest,
  complete: ProfileCompleter,
  options: { timeoutMs?: number } = {},
): Promise<GeneratedAgentProfile> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Profile generation timed out."));
    }, options.timeoutMs ?? AGENT_PROFILE_TIMEOUT_MS);
  });
  try {
    const text = await Promise.race([
      complete({
        modelId: request.modelId,
        systemPrompt: AGENT_PROFILE_SYSTEM_PROMPT,
        prompt: buildAgentProfilePrompt(request),
        signal: controller.signal,
      }),
      timeout,
    ]);
    const profile = parseAgentProfile(text);
    if (!profile) {
      console.warn("[modus] agent profile generation returned invalid JSON.");
      return fallbackAgentProfile();
    }
    return { ...profile, generated: true };
  } catch (error) {
    console.warn(
      "[modus] agent profile generation failed:",
      error instanceof Error ? error.message : error,
    );
    return fallbackAgentProfile();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
