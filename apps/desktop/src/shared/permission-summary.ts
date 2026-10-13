/**
 * App-generated description of a tool call awaiting approval. Built only from
 * the tool name and its arguments — never from model-written prose — so the
 * approval card cannot be talked into describing a call as something else.
 */
export type ToolCallDescription = {
  /** Short sentence, e.g. "Run JavaScript in tab tab-2". */
  summary: string;
  /** Exact payload that will execute (code, command, params), for "Show details". */
  details?: string;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function inTab(viewId: string | undefined): string {
  return viewId ? ` in tab ${viewId}` : " in the active tab";
}

function describeCdp(input: Record<string, unknown>): ToolCallDescription {
  const method = str(input.method) ?? "unknown method";
  const params = record(input.params);
  const tab = inTab(str(input.viewId));
  if (method === "Runtime.evaluate" && typeof params.expression === "string") {
    return { summary: `Run JavaScript${tab}`, details: params.expression };
  }
  if (method === "Runtime.callFunctionOn" && typeof params.functionDeclaration === "string") {
    return { summary: `Run JavaScript${tab}`, details: params.functionDeclaration };
  }
  if (method === "Page.navigate" && str(params.url)) {
    return { summary: `Open ${params.url as string}${tab}` };
  }
  if (method.startsWith("Input.")) {
    return { summary: `Send input to the page${tab}`, details: JSON.stringify(params, null, 2) };
  }
  return {
    summary: `Send browser command ${method}${tab}`,
    details: JSON.stringify(params, null, 2),
  };
}

function prefixLines(text: string, prefix: string): string[] {
  return text.split("\n").map((line) => `${prefix}${line}`);
}

/** Every replacement in an edit call rendered as one diff: removed lines with "-", added with "+". */
export function editDiff(input: Record<string, unknown>): string {
  const pairs: Array<{ oldText: string; newText: string }> = [];
  const pushPair = (value: unknown) => {
    const item = record(value);
    const oldText = item.oldText ?? item.old_string ?? item.oldString;
    const newText = item.newText ?? item.new_string ?? item.newString;
    if (typeof oldText === "string" || typeof newText === "string") {
      pairs.push({
        oldText: typeof oldText === "string" ? oldText : "",
        newText: typeof newText === "string" ? newText : "",
      });
    }
  };
  if (Array.isArray(input.edits)) for (const edit of input.edits) pushPair(edit);
  else pushPair(input);
  if (!pairs.length) return JSON.stringify(input, null, 2);
  return pairs
    .map(({ oldText, newText }) =>
      ["@@", ...prefixLines(oldText, "-"), ...prefixLines(newText, "+")].join("\n"),
    )
    .join("\n");
}

export function describeToolCall(toolName: string, rawInput: unknown): ToolCallDescription {
  const input = record(rawInput);
  if (toolName === "browser_cdp") return describeCdp(input);
  if (toolName === "browser_tabs") {
    const action = str(input.action);
    if (action === "new")
      return { summary: `Open a new tab${str(input.url) ? ` at ${input.url}` : ""}` };
    if (action === "close") return { summary: `Close tab ${str(input.viewId) ?? "(active)"}` };
    if (action === "select") return { summary: `Switch to tab ${str(input.viewId) ?? "(active)"}` };
    return { summary: "List browser tabs" };
  }
  const command = str(input.command);
  if (command !== undefined) return { summary: `Run a shell command`, details: command };
  const path = str(input.path);
  if (path !== undefined) {
    if (toolName === "write") {
      const content = typeof input.content === "string" ? input.content : "";
      return { summary: `Write file ${path}`, details: content };
    }
    if (toolName === "edit") return { summary: `Edit file ${path}`, details: editDiff(input) };
    return { summary: `Use ${toolName} on ${path}` };
  }
  return { summary: `Use tool ${toolName}`, details: JSON.stringify(input, null, 2) };
}
