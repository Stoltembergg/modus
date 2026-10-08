import type { ToolResultPolicy } from "./tool-result-policy";
import type { SpilledToolResult } from "./tool-result-storage";

/**
 * Generates an informative, compact preview of a spilled tool result.
 * Supports both line-oriented output (scripts, git diffs, logs) and
 * char-oriented minified outputs (raw JSON, base64 strings).
 */
export function generateSpillPreview(spill: SpilledToolResult, policy: ToolResultPolicy): string {
  const lines = spill.fullContent.split("\n");
  const totalLines = lines.length;
  const tokenEstimate = Math.ceil(spill.sizeBytes / 4);

  // Case 1: Line-rich output (e.g. bash logs, test runs, git status, grep)
  if (totalLines > policy.previewHeadLines + policy.previewTailLines) {
    const head = lines.slice(0, policy.previewHeadLines).join("\n");
    const tail = lines.slice(-policy.previewTailLines).join("\n");
    const omitted = totalLines - policy.previewHeadLines - policy.previewTailLines;

    return `[Large output spilled: ${spill.sizeBytes.toLocaleString()} bytes (~${tokenEstimate.toLocaleString()} tokens), ${totalLines.toLocaleString()} lines]
--- Output Preview (first ${policy.previewHeadLines} lines) ---
${head}

[... ${omitted.toLocaleString()} lines omitted ...]

--- Output Preview (last ${policy.previewTailLines} lines) ---
${tail}
--------------------------------------------------------
[Full output saved with ID: "${spill.id}". Inspect sections using retrieve_spilled_tool_result(spillId: "${spill.id}", offsetLine, limitLines)]`;
  }

  // Case 2: Few lines but large payload (e.g. single-line minified JSON, long tokens)
  const headChars = spill.fullContent.slice(0, policy.previewHeadChars);
  const tailChars = spill.fullContent.slice(-policy.previewTailChars);
  const omittedChars = spill.fullContent.length - policy.previewHeadChars - policy.previewTailChars;

  return `[Large output spilled: ${spill.sizeBytes.toLocaleString()} bytes (~${tokenEstimate.toLocaleString()} tokens), ${totalLines} lines]
--- Output Preview (first ${policy.previewHeadChars} chars) ---
${headChars}

[... ${omittedChars.toLocaleString()} characters omitted ...]

--- Output Preview (last ${policy.previewTailChars} chars) ---
${tailChars}
--------------------------------------------------------
[Full output saved with ID: "${spill.id}". Retrieve with retrieve_spilled_tool_result(spillId: "${spill.id}")]`;
}
