/**
 * The main process sends a subagent its role wrapped as
 * `<subagent_definition …>…</subagent_definition>\n\n<task>…</task>` (composeSubagentPrompt).
 * That definition is internal: the user only sees the task.
 */
const DEFINITION = /^\s*<subagent_definition\b[^>]*>[\s\S]*?(?:<\/subagent_definition>|$)/;
const TASK = /^\s*<task>\s*([\s\S]*?)\s*(?:<\/task>\s*)?$/;

export function visibleSubagentPrompt(text: string): string {
  if (!DEFINITION.test(text)) return text;
  const rest = text.replace(DEFINITION, "");
  const task = TASK.exec(rest);
  return (task ? (task[1] ?? "") : rest).trim();
}
