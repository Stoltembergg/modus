/**
 * Prompt Kit–aligned helpers for the Group Room transcript.
 * Safe progress labels only — never raw model thinking.
 */

/** Minimal tool row for Steps / CoT (mirrors live turn tools). */
export type GroupSafeToolLine = {
  id: string;
  name: string;
  label: string;
  done: boolean;
};

/** Attachment meta shown as chips (no payload). */
export type GroupAttachmentMeta = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  /** data: URL for image previews when available. */
  previewUrl?: string;
};

/** Severity for rare System Message rows (Prompt Kit). */
export type GroupSystemVariant = "action" | "warning" | "error";

/**
 * Classify a status body for rare System Message treatment.
 * Routine ops (worktree, archived noise) stay faint or Activity-only.
 */
export function classifyGroupSystemStatus(body: string): {
  show: "system" | "faint" | "hide";
  variant: GroupSystemVariant;
} | null {
  const text = body.trim();
  if (!text) return null;
  if (/^Waiting for you/i.test(text)) {
    return { show: "system", variant: "action" };
  }
  if (/^Blocked/i.test(text) || /^Turn failed/i.test(text)) {
    return { show: "system", variant: "error" };
  }
  if (/^Stopped by you/i.test(text) || /^Turn stopped/i.test(text)) {
    return { show: "system", variant: "warning" };
  }
  // Tool-generated coordination is already represented by Decisions / Tasks.
  // Keep its protocol log out of the conversation transcript.
  if (/^(?:Decision|Assigned|Reassigned):/i.test(text)) {
    return { show: "hide", variant: "action" };
  }
  if (/^Worktree ready:/i.test(text)) {
    return { show: "hide", variant: "action" };
  }
  if (/ is archived$/i.test(text)) {
    return { show: "faint", variant: "warning" };
  }
  // Ready / Queued / Still working are ephemeral UI — never transcript rows.
  if (
    /^Ready for you\.?$/i.test(text) ||
    /^Pronto para você\.?$/i.test(text) ||
    /^Queued…?$/i.test(text) ||
    /^Na fila…?$/i.test(text) ||
    /^Still working…?$/i.test(text)
  ) {
    return { show: "hide", variant: "action" };
  }
  if (/^No next owner/i.test(text)) {
    return { show: "system", variant: "action" };
  }
  return { show: "faint", variant: "action" };
}

/**
 * Build expandable Steps labels from live tools (Prompt Kit Steps).
 * Compact verbs only — tool args stay in Activity.
 */
export function buildGroupStepsLabels(tools: readonly GroupSafeToolLine[]): string[] {
  return tools.map((tool) => (tool.done ? `${tool.label}` : `${tool.label}…`));
}

/**
 * Safe Chain-of-Thought summaries from phase / tools / presence — never raw thought.
 */
export function buildSafeChainOfThought(input: {
  phase: string;
  activity?: string | undefined;
  tools: readonly GroupSafeToolLine[];
  hasStream: boolean;
}): string[] {
  const steps: string[] = [];
  const phase = input.phase.trim();
  if (phase && !/^done$/i.test(phase) && !/^failed$/i.test(phase) && !/^stopped$/i.test(phase)) {
    steps.push(humanizePhase(phase));
  }
  const activity = input.activity?.trim();
  if (
    activity &&
    !steps.some((s) => s.toLocaleLowerCase().includes(activity.toLocaleLowerCase()))
  ) {
    steps.push(capitalizeSentence(activity));
  }
  for (const tool of input.tools) {
    const label = tool.done ? `Finished ${tool.label.toLocaleLowerCase()}` : tool.label;
    if (!steps.includes(label)) steps.push(label);
  }
  if (input.hasStream && !steps.some((s) => /writ/i.test(s))) {
    steps.push("Writing a reply");
  }
  return steps.slice(0, 8);
}

function humanizePhase(phase: string): string {
  const lower = phase.toLocaleLowerCase();
  if (lower === "thinking" || /waiting on model/i.test(phase)) return "Waiting on model…";
  if (lower === "queued") return "Waiting for its turn";
  if (lower === "exploring" || lower.startsWith("explor")) return "Exploring the codebase";
  if (lower === "reviewing" || lower.startsWith("review")) return "Reviewing the work";
  if (lower === "writing" || lower.startsWith("writ")) return "Writing a reply";
  if (lower === "working" || lower.startsWith("implement")) return "Implementing changes";
  if (/test/i.test(phase)) return "Running tests";
  if (/waiting/i.test(phase))
    return phase.endsWith("…") || phase.endsWith("...") ? phase : `${phase}…`;
  return capitalizeSentence(phase);
}

function capitalizeSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toLocaleUpperCase() + trimmed.slice(1);
}

/** Format bytes for attachment chips. */
export function formatAttachmentSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
