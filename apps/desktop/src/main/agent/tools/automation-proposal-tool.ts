import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { AutomationSchedule, CreateAutomationInput } from "../../../shared/automations";
import { AUTOMATION_PROPOSAL_TOOL_NAME, AUTOMATION_PROPOSAL_TOOL_UI } from "../../../shared/tools";
import { getAgent } from "../../agents/agents-store";
import { nextAutomationOccurrence } from "../../automations/automation-schedule";
import { requestQuestions } from "../../interaction/question-broker";
import { getWorkspace } from "../../workspace/workspace-store";
import { getAgentSession } from "../agent-store";
import { toolRegistry } from "./registry";
import { resolveAgentToolContext } from "./tool-context";

const scheduleParams = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("once"),
      at: Type.String({
        minLength: 1,
        description: "RFC 3339 date and time, including its UTC offset.",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("daily"),
      local_time: Type.String({
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
        description: "Local time in HH:mm.",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("weekly"),
      days_of_week: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
        minItems: 1,
        maxItems: 7,
        description: "Weekdays as Sunday=0 through Saturday=6.",
      }),
      local_time: Type.String({
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
        description: "Local time in HH:mm.",
      }),
    },
    { additionalProperties: false },
  ),
]);

export const proposeAutomationParams = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 120,
      description: "Short name shown in Automations.",
    }),
    instruction: Type.String({
      minLength: 1,
      maxLength: 65_536,
      description: "The exact prompt Modus will run.",
    }),
    schedule: scheduleParams,
    time_zone: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description:
          "IANA timezone, such as America/Sao_Paulo. Defaults to this device's timezone.",
      }),
    ),
  },
  { additionalProperties: false },
);

type Proposal = Static<typeof proposeAutomationParams>;

function toSchedule(schedule: Proposal["schedule"]): AutomationSchedule {
  if (schedule.kind === "once") return { kind: "once", at: schedule.at };
  if (schedule.kind === "daily") {
    return { kind: "daily", localTime: schedule.local_time };
  }
  return {
    kind: "weekly",
    daysOfWeek: schedule.days_of_week,
    localTime: schedule.local_time,
  };
}

function describeSchedule(schedule: AutomationSchedule, timeZone: string): string {
  switch (schedule.kind) {
    case "once":
      return `Once at ${new Date(schedule.at).toLocaleString()} (${timeZone})`;
    case "daily":
      return `Daily at ${schedule.localTime} (${timeZone})`;
    case "weekly": {
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return `Weekly on ${schedule.daysOfWeek.map((day) => days[day]).join(", ")} at ${schedule.localTime} (${timeZone})`;
    }
  }
}

function result(text: string, created: boolean): AgentToolResult<{ created: boolean }> {
  return { content: [{ type: "text", text }], details: { created } };
}

const proposeAutomationTool: ToolDefinition = defineTool({
  name: AUTOMATION_PROPOSAL_TOOL_NAME,
  label: "Propose automation",
  description:
    "Propose a one-time, daily, or weekly automation for the user's current Project, Agent and selected model. " +
    "The proposal is shown for explicit confirmation and is not saved or run unless the user confirms it. " +
    "Never use this to change or start an existing automation.",
  parameters: proposeAutomationParams,
  execute: async (_id, params: Proposal, signal, _onUpdate, toolContext) => {
    if (!Value.Check(proposeAutomationParams, params)) {
      throw new Error("Invalid automation proposal parameters.");
    }
    const context = resolveAgentToolContext(toolContext.cwd);
    if (!context.sessionId || !context.emit || context.profile !== "chat") {
      throw new Error("Automation proposals require an active chat session.");
    }
    if (context.parentSessionId || context.groupId) {
      throw new Error("Automation proposals are only available in a personal chat.");
    }

    const session = getAgentSession(context.sessionId);
    if (!session || session.kind === "group_member" || session.parentSessionId) {
      throw new Error("The current chat cannot own an automation.");
    }
    if (session.workspaceId !== context.workspaceId) {
      throw new Error(
        "The current Project changed. Start a new chat turn before proposing an automation.",
      );
    }
    const workspace = getWorkspace(session.workspaceId);
    if (!workspace || workspace.inbox || session.cwd !== workspace.rootPath) {
      throw new Error("Automations require a chat opened at the root of an available Project.");
    }

    const modelId = context.modelId;
    const separator = modelId?.indexOf("/") ?? -1;
    if (!modelId || separator < 1 || separator === modelId.length - 1) {
      throw new Error("A selected model is required before proposing an automation.");
    }

    const agentId = session.agentId ?? null;
    const agent = agentId ? getAgent(agentId) : undefined;
    if (agentId && (!agent || agent.archivedAt)) {
      throw new Error("The current Agent is no longer available.");
    }

    const schedule = toSchedule(params.schedule);
    const timeZone = params.time_zone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date().toISOString();
    if (!nextAutomationOccurrence(schedule, timeZone, now)) {
      throw new Error("Choose a future date and time for this automation.");
    }

    const input: CreateAutomationInput = {
      name: params.name.trim(),
      instruction: params.instruction.trim(),
      schedule,
      timeZone,
      workspaceId: workspace.id,
      cwd: workspace.rootPath,
      agentId,
      providerId: modelId.slice(0, separator),
      modelId,
      thinkingLevel: context.thinkingLevel ?? "minimal",
      ...(context.thinkingVariant ? { thinkingVariant: context.thinkingVariant } : {}),
      enabled: true,
    };

    const scheduleDescription = describeSchedule(schedule, timeZone);
    const response = await requestQuestions({
      sessionId: context.sessionId,
      ...(context.runId ? { runId: context.runId } : {}),
      emit: context.emit,
      ...(signal ? { signal } : {}),
      questions: [
        {
          id: "automation-confirm",
          header: `Create automation “${input.name}”?`,
          detail: [
            `Project: ${workspace.displayName}`,
            `Agent: ${agent?.name ?? "Modus"}`,
            `Model: ${modelId}`,
            `Schedule: ${scheduleDescription}`,
            `Instruction: ${input.instruction}`,
          ].join("\n"),
          multiSelect: false,
          options: [{ label: "Create this automation", recommended: true }, { label: "Cancel" }],
        },
      ],
    });

    const confirmation = response.answers.find(
      (answer) => answer.questionId === "automation-confirm",
    );
    const confirmed =
      !signal?.aborted &&
      !response.skipped &&
      confirmation?.selected.length === 1 &&
      confirmation.selected[0] === "Create this automation" &&
      !confirmation.custom;
    if (!confirmed)
      return result("Automation proposal cancelled; nothing was saved or run.", false);

    const { getAutomationService } = await import("../../automations/automation-service-instance");
    const created = await getAutomationService().createDefinition(input);
    return result(
      `Automation “${created.name}” was created. It will run ${scheduleDescription}.`,
      true,
    );
  },
});

let registered = false;

export function registerAutomationProposalTool(): void {
  if (registered) return;
  registered = true;
  toolRegistry.registerTool({
    entry: {
      name: AUTOMATION_PROPOSAL_TOOL_NAME,
      profiles: ["chat"],
      permission: { danger: "safe" },
      capabilities: [],
      readOnly: false,
      ui: AUTOMATION_PROPOSAL_TOOL_UI,
    },
    definition: proposeAutomationTool,
  });
}
