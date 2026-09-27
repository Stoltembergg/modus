import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ProjectMemoryCategory } from "../../../shared/contracts";
import {
  type ProjectMemoryProposalInput,
  proposeProjectMemory,
} from "../../memory/project-memory-service";
import { getActiveAgentRun } from "../agent-run-store";
import { resolveMcpCitation } from "../harness/mcp-citation-registry";
import { toolRegistry } from "./registry";
import { resolveAgentToolContext } from "./tool-context";

export const PROJECT_MEMORY_TOOL_NAME = "project_memory_propose";

const categorySchema = Type.Union([
  Type.Literal("decision"),
  Type.Literal("architecture"),
  Type.Literal("convention"),
  Type.Literal("constraint"),
  Type.Literal("known_issue"),
  Type.Literal("solution"),
  Type.Literal("failed_attempt"),
  Type.Literal("task_result"),
  Type.Literal("preference"),
]);

const localEvidenceSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("user_message"),
      Type.Literal("run"),
      Type.Literal("task"),
      Type.Literal("subagent"),
      Type.Literal("commit"),
      Type.Literal("file"),
      Type.Literal("symbol"),
    ]),
    taskRef: Type.Optional(Type.String({ maxLength: 1024 })),
    commitSha: Type.Optional(Type.String({ maxLength: 1024 })),
    branch: Type.Optional(Type.String({ maxLength: 1024 })),
    path: Type.Optional(Type.String({ maxLength: 1024 })),
    symbol: Type.Optional(Type.String({ maxLength: 1024 })),
  },
  { additionalProperties: false },
);
const externalUrlReferenceSchema = Type.Object(
  {
    kind: Type.Literal("external_reference"),
    url: Type.String({ minLength: 1, maxLength: 1024 }),
    title: Type.Optional(Type.String({ maxLength: 1024 })),
  },
  { additionalProperties: false },
);
const externalCitationReferenceSchema = Type.Object(
  {
    kind: Type.Literal("external_reference"),
    citationId: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);
const evidenceSchema = Type.Union([
  localEvidenceSchema,
  externalUrlReferenceSchema,
  externalCitationReferenceSchema,
]);

const proposalSchema = Type.Object(
  {
    scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
    category: categorySchema,
    title: Type.String({ minLength: 2, maxLength: 160 }),
    claim: Type.String({ minLength: 16, maxLength: 1200 }),
    evidence: Type.Array(evidenceSchema, { minItems: 1, maxItems: 32 }),
    supersedesId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

type ProposalParams = Static<typeof proposalSchema>;

function toResult(
  candidateId: string,
  category: ProjectMemoryCategory,
): AgentToolResult<{ candidateId: string; category: ProjectMemoryCategory }> {
  return {
    content: [{ type: "text", text: `Project memory candidate ${candidateId} (${category}).` }],
    details: { candidateId, category },
  };
}

const projectMemoryTool: ToolDefinition = defineTool({
  name: PROJECT_MEMORY_TOOL_NAME,
  label: "Propose project memory",
  description:
    "Propose one concise, evidence-backed memory for the current project or a user preference/convention shared globally. " +
    "Only use this for durable decisions, constraints, reusable fixes, meaningful failed attempts, or task outcomes—not ordinary narration. " +
    "Do not include transcripts, copied source text, credentials, or speculative plans.",
  promptSnippet:
    "project_memory_propose(scope, category, title, claim, evidence, supersedesId?) — propose a concise, cited durable fact; session/run/workspace identity is supplied by Modus.",
  promptGuidelines: [
    "Propose only durable decisions, constraints, reusable fixes, meaningful failed attempts, or task outcomes; never ordinary narration or speculative plans.",
    "Keep claims concise and cite the current run, task, file, symbol, commit, or user message; do not copy transcripts or source contents.",
    "Global scope is only for user-origin preferences or cross-project conventions explicitly grounded in the current user message; project code facts stay project-scoped.",
  ],
  parameters: proposalSchema,
  execute: async (_toolCallId, params: ProposalParams, _signal, _onUpdate, ctx) => {
    const owner = resolveAgentToolContext(ctx.cwd);
    if (!owner.sessionId || !owner.workspaceId) {
      throw new Error("Project memory proposal requires an owning Modus session and workspace.");
    }
    const run = getActiveAgentRun(owner.sessionId);
    if (!run) {
      throw new Error("Project memory proposal requires an active owning run.");
    }

    const evidence: ProjectMemoryProposalInput["evidence"] = params.evidence.map((item) => {
      if (item.kind === "external_reference" && "citationId" in item) {
        const citation = resolveMcpCitation(owner.sessionId, run.id, item.citationId);
        if (!citation)
          throw new Error("External citation ID is unknown, expired, or not owned by this run.");
        return { kind: "external_reference", citationId: citation.id };
      }
      return item.kind === "external_reference"
        ? {
            kind: "external_reference",
            externalReference: {
              url: item.url,
              ...(item.title ? { title: item.title } : {}),
              sourceLabel: "Agent-supplied",
              retrievedAt: new Date().toISOString(),
              origin: "agent_supplied_unverified",
            },
            sessionId: owner.sessionId,
            runId: run.id,
          }
        : {
            ...item,
            sessionId: owner.sessionId,
            runId: run.id,
            ...(item.kind === "user_message" && run.userMessageId
              ? { userMessageId: run.userMessageId }
              : {}),
          };
    });
    const record = proposeProjectMemory(
      { ...params, category: params.category as ProjectMemoryCategory, evidence },
      {
        workspaceId: owner.workspaceId,
        sessionId: owner.sessionId,
        runId: run.id,
        ...(run.userMessageId ? { userMessageId: run.userMessageId } : {}),
        cwd: owner.cwd,
        ...(owner.parentSessionId ? { parentSessionId: owner.parentSessionId } : {}),
      },
    );
    return toResult(record.id, record.category);
  },
});

let registered = false;

/** Register the proposal tool into the chat profile (idempotent). */
export function registerProjectMemoryTools(): void {
  if (registered) return;
  registered = true;
  toolRegistry.registerTool({
    entry: {
      name: PROJECT_MEMORY_TOOL_NAME,
      profiles: ["chat"],
      permission: { danger: "safe" },
      capabilities: ["write"],
      readOnly: false,
      ui: { verb: "Proposed", primaryArgKey: "title" },
    },
    definition: projectMemoryTool,
  });
}
