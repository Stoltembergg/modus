import type {
  AgentInfo,
  AgentSessionInfo,
  CreateGroupAgentInput,
  GenerateAgentProfileInput,
  GeneratedAgentProfile,
  UpdateAgentInput,
} from "../../shared/contracts";
import { requireAgentModel } from "./agent-model-rule";
import { IPC_CHANNELS } from "./channels";
import { toGroupIpcError } from "./group-ipc";
import {
  agentsArchiveSchema,
  agentsCreateSchema,
  agentsGenerateProfileSchema,
  agentsIdSchema,
  agentsUpdateSchema,
  parseIpcInput,
} from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

/** The agents-store operations (injected so the IPC layer is testable). */
export type AgentsIpcService = {
  listAgents(): AgentInfo[];
  /** A new agent in its (only) group: membership and room session included. */
  createAgentInGroup(input: CreateGroupAgentInput): AgentInfo;
  getAgent(agentId: string): AgentInfo | undefined;
  /** Whether `modelId` belongs to a configured provider (listModels). */
  isModelAvailable(modelId: string): boolean;
  updateAgent(agentId: string, input: UpdateAgentInput): unknown;
  setAgentArchived(agentId: string, archived: boolean): unknown;
  /** Same operation as removing the member: `group-min-members` when 2 are left. */
  /** Resolves once the agent's sessions are torn down (after the store commit). */
  deleteAgent(agentId: string): void | Promise<void>;
  /** The agent's 1:1 chat, made on first open (`group-project-required` without a Project). */
  openAgentChat(agentId: string): AgentSessionInfo;
  /** Role + instructions from the chosen model; never rejects (falls back instead). */
  generateAgentProfile(input: GenerateAgentProfileInput): Promise<GeneratedAgentProfile>;
};

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

type ParsedAgentFields = { [K in keyof UpdateAgentInput]?: UpdateAgentInput[K] | undefined };

/** Only the fields present in the parsed payload (exactOptionalPropertyTypes). */
function definedFields(input: ParsedAgentFields): UpdateAgentInput {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as UpdateAgentInput;
}

/**
 * `agents:*` handlers, same shape as `group:*`: every mutation except create
 * returns the refreshed agent list; store error codes cross IPC in the
 * `[group-error:<code>]` message format.
 */
export function registerAgentsIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: AgentsIpcService,
): void {
  const list = () => service.listAgents();
  const ipc: HandlerRegistration = {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, input) => {
        try {
          return listener(event, input);
        } catch (error) {
          throw toGroupIpcError(error);
        }
      });
    },
  };

  ipc.handle(IPC_CHANNELS.agentsList, (event, input) => {
    assertTrustedSender(event);
    if (input !== undefined) {
      throw new Error(`Invalid IPC payload for ${IPC_CHANNELS.agentsList}: expected no input`);
    }
    return list();
  });

  ipc.handle(IPC_CHANNELS.agentsCreate, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(agentsCreateSchema, input, IPC_CHANNELS.agentsCreate);
    requireAgentModel(service.isModelAvailable, parsed);
    const { groupId, templateId, ...fields } = parsed;
    return service.createAgentInGroup({
      ...definedFields(fields),
      name: parsed.name,
      groupId,
      ...(templateId !== undefined ? { templateId } : {}),
    });
  });

  ipc.handle(IPC_CHANNELS.agentsUpdate, (event, input) => {
    assertTrustedSender(event);
    const { id, ...fields } = parseIpcInput(agentsUpdateSchema, input, IPC_CHANNELS.agentsUpdate);
    const current = service.getAgent(id);
    if (current) {
      const changed = fields.modelId !== undefined;
      requireAgentModel(
        service.isModelAvailable,
        { templateId: current.templateId, modelId: changed ? fields.modelId : current.modelId },
        changed,
      );
    }
    service.updateAgent(id, definedFields(fields));
    return list();
  });

  ipc.handle(IPC_CHANNELS.agentsArchive, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(agentsArchiveSchema, input, IPC_CHANNELS.agentsArchive);
    service.setAgentArchived(parsed.id, parsed.archived);
    return list();
  });

  ipc.handle(IPC_CHANNELS.agentsOpenChat, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(agentsIdSchema, input, IPC_CHANNELS.agentsOpenChat);
    return service.openAgentChat(parsed.id);
  });

  // Only a custom agent needs this, so its model rule applies (a model of a
  // configured provider) before any call is made.
  ipc.handle(IPC_CHANNELS.agentsGenerateProfile, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      agentsGenerateProfileSchema,
      input,
      IPC_CHANNELS.agentsGenerateProfile,
    );
    requireAgentModel(service.isModelAvailable, { modelId: parsed.modelId });
    const roles = parsed.roles?.map((role) => role.trim()).filter(Boolean);
    return service.generateAgentProfile({
      ...(parsed.groupId ? { groupId: parsed.groupId } : {}),
      ...(roles?.length ? { roles } : {}),
      modelId: parsed.modelId,
      name: parsed.name,
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
    });
  });

  ipc.handle(IPC_CHANNELS.agentsDelete, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(agentsIdSchema, input, IPC_CHANNELS.agentsDelete);
    // The store call throws synchronously (error format kept); then await the teardown.
    return Promise.resolve(service.deleteAgent(parsed.id)).then(list);
  });
}
