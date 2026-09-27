export type BuiltinSubagentRole =
  | "explore"
  | "librarian"
  | "oracle"
  | "reviewer"
  | "debugger"
  | "ui-ux";

export type BuiltinSubagentProfile = {
  name: BuiltinSubagentRole;
  role: BuiltinSubagentRole;
  description: string;
  model: "inherit";
  readOnly: boolean;
  tools: string[];
  disallowedTools: string[];
  isolation: "shared" | "worktree";
  source: "builtin";
  body: string;
};

const READ_TOOLS = ["read", "grep", "find", "ls", "fast_codebase"];

export const BUILTIN_SUBAGENTS: BuiltinSubagentProfile[] = [
  {
    name: "explore",
    role: "explore",
    description: "Explore the codebase and report relevant files and findings.",
    model: "inherit",
    readOnly: true,
    tools: READ_TOOLS,
    disallowedTools: ["write", "edit", "shell", "process"],
    isolation: "shared",
    source: "builtin",
    body: "Explore only. Do not modify files or run commands. Return concise findings with file references.",
  },
  {
    name: "librarian",
    role: "librarian",
    description: "Research documentation and configured read-only external sources.",
    model: "inherit",
    readOnly: true,
    tools: [...READ_TOOLS, "web_search", "web_fetch", "mcp:read-only-allowlist"],
    disallowedTools: ["write", "edit", "shell", "process", "mcp"],
    isolation: "shared",
    source: "builtin",
    body: "Research only. Use web tools and only explicitly allowlisted read-only MCP search tools; never call other MCP tools. Cite sources and keep findings concise.",
  },
  {
    name: "oracle",
    role: "oracle",
    description: "Provide an independent, bounded read-only analysis of a proposal.",
    model: "inherit",
    readOnly: true,
    tools: READ_TOOLS,
    disallowedTools: ["write", "edit", "shell", "process", "mcp"],
    isolation: "shared",
    source: "builtin",
    body: "Analyze independently without changing files or running commands. Return concise, evidence-backed conclusions.",
  },
  {
    name: "reviewer",
    role: "reviewer",
    description: "Review changes for correctness, regressions, and security issues.",
    model: "inherit",
    readOnly: true,
    tools: READ_TOOLS,
    disallowedTools: ["write", "edit", "shell", "process", "mcp"],
    isolation: "shared",
    source: "builtin",
    body: "Review only. Do not edit or execute commands. Report actionable findings with file and line references.",
  },
  {
    name: "debugger",
    role: "debugger",
    description:
      "Diagnose failures through read-only inspection without running commands or changing files.",
    model: "inherit",
    readOnly: true,
    tools: READ_TOOLS,
    disallowedTools: [
      "write",
      "edit",
      "shell",
      "process",
      "terminal_run",
      "terminal_read",
      "terminal_list",
      "terminal_write",
      "terminal_kill",
      "mcp",
    ],
    isolation: "shared",
    source: "builtin",
    body: "Inspect code and available read-only evidence only. Do not run commands or use shell, process, or terminal tools; never write or edit files.",
  },
  {
    name: "ui-ux",
    role: "ui-ux",
    description: "Review renderer design and usability through read-only inspection.",
    model: "inherit",
    readOnly: true,
    tools: READ_TOOLS,
    disallowedTools: [
      "write",
      "edit",
      "shell",
      "process",
      "terminal_run",
      "terminal_read",
      "terminal_list",
      "terminal_write",
      "terminal_kill",
      "mcp",
    ],
    isolation: "shared",
    source: "builtin",
    body: "Design and review only. Inspect renderer files and report recommendations; do not change files or use shell, process, or terminal tools.",
  },
];

export function getBuiltinSubagentManifest(): string {
  return [
    "## Built-in subagents (defaults; user/workspace profiles override by exact name)",
    ...BUILTIN_SUBAGENTS.map(
      ({ name, description, readOnly, tools, isolation }) =>
        `- ${name}: ${description} (${readOnly ? "read-only" : "permission-gated diagnostics"}; tools=${tools.join("|")}; isolation=${isolation})`,
    ),
  ].join("\n");
}
