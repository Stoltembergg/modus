import type { ResponseLevel } from "./response-policy";

export type DeliverableType = "file_changed" | "diff" | "tool_result" | "evidence" | "decision";

export type Deliverable = {
  type: DeliverableType;
  id: string;
  label: string;
  path?: string | undefined;
  content?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

/**
 * Formats a list of deliverables into a concise Markdown summary block
 * tailored to the requested ResponseLevel.
 */
export function formatDeliverables(
  deliverables: Deliverable[],
  level: ResponseLevel = "standard",
): string {
  if (!deliverables || deliverables.length === 0) {
    return "";
  }

  // Verbose: full details
  if (level === "verbose") {
    const lines: string[] = ["### Deliverables"];
    for (const d of deliverables) {
      lines.push(`- **[${d.type}]** ${d.label}${d.path ? ` (\`${d.path}\`)` : ""}`);
      if (d.content) {
        lines.push(`  \`\`\`\n  ${d.content.slice(0, 500)}\n  \`\`\``);
      }
    }
    return lines.join("\n");
  }

  // Detailed: lists with paths and types
  if (level === "detailed") {
    const lines: string[] = ["### Deliverables"];
    for (const d of deliverables) {
      lines.push(`- **${d.label}** (${d.type})${d.path ? `: \`${d.path}\`` : ""}`);
    }
    return lines.join("\n");
  }

  // Standard: grouped bullet summary
  if (level === "standard") {
    const files = deliverables.filter((d) => d.type === "file_changed" || d.type === "diff");
    const others = deliverables.filter((d) => d.type !== "file_changed" && d.type !== "diff");

    const lines: string[] = [];
    if (files.length > 0) {
      lines.push(`**Files affected**: ${files.map((f) => `\`${f.path || f.label}\``).join(", ")}`);
    }
    if (others.length > 0) {
      lines.push(`**Key items**: ${others.map((o) => o.label).join("; ")}`);
    }
    return lines.join("\n\n");
  }

  // Compact: minimal one-liner
  const fileCount = deliverables.filter(
    (d) => d.type === "file_changed" || d.type === "diff",
  ).length;
  if (fileCount > 0) {
    return `*${fileCount} file(s) modified.*`;
  }
  return `*${deliverables.length} item(s) delivered.*`;
}
