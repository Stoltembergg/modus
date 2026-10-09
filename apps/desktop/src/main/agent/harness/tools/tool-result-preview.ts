import type { ToolResultPolicy } from "./tool-result-policy";
import type { SpilledToolResult } from "./tool-result-storage";

const MAX_PREVIEW_SECTION_BYTES = 2 * 1024;

function boundedUtf8(value: string, maxBytes: number): string {
  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + bytes > maxBytes) break;
    result += character;
    usedBytes += bytes;
  }
  return result;
}

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
    const head = boundedUtf8(
      lines.slice(0, policy.previewHeadLines).join("\n"),
      MAX_PREVIEW_SECTION_BYTES,
    );
    const tail = boundedUtf8(
      lines.slice(-policy.previewTailLines).join("\n"),
      MAX_PREVIEW_SECTION_BYTES,
    );
    const omitted = totalLines - policy.previewHeadLines - policy.previewTailLines;

    return `[Large output spilled: ${spill.sizeBytes.toLocaleString()} bytes (about ${tokenEstimate.toLocaleString()} estimated tokens), ${totalLines.toLocaleString()} lines]
--- Output Preview (first ${policy.previewHeadLines} lines) ---
${head}

[... ${omitted.toLocaleString()} lines omitted ...]

--- Output Preview (last ${policy.previewTailLines} lines) ---
${tail}
--------------------------------------------------------
[Full output saved with ID: "${spill.id}". Retrieve using retrieve_spilled_tool_result(spill_id: "${spill.id}", offset_line: 0, limit_lines: 100, max_bytes: 16384)]`;
  }

  // Case 2: Few lines but large payload (e.g. single-line minified JSON, long tokens)
  const headChars = boundedUtf8(
    spill.fullContent.slice(0, policy.previewHeadChars),
    MAX_PREVIEW_SECTION_BYTES,
  );
  const tailChars = boundedUtf8(
    spill.fullContent.slice(-policy.previewTailChars),
    MAX_PREVIEW_SECTION_BYTES,
  );
  const omittedChars = spill.fullContent.length - policy.previewHeadChars - policy.previewTailChars;

  return `[Large output spilled: ${spill.sizeBytes.toLocaleString()} bytes (about ${tokenEstimate.toLocaleString()} estimated tokens), ${totalLines} lines]
--- Output Preview (first ${policy.previewHeadChars} chars) ---
${headChars}

[... ${omittedChars.toLocaleString()} characters omitted ...]

--- Output Preview (last ${policy.previewTailChars} chars) ---
${tailChars}
--------------------------------------------------------
[Full output saved with ID: "${spill.id}". Retrieve using retrieve_spilled_tool_result(spill_id: "${spill.id}", offset_byte: 0, max_bytes: 16384)]`;
}
