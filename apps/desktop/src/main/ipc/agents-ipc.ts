import type { AgentInfo, CreateAgentInput, UpdateAgentInput } from "../../shared/contracts";
import { IPC_CHANNELS } from "./channels";
import { toGroupIpcError } from "./group-ipc";
import {
  agentsArchiveSchema,
  agentsCreateSchema,
  agentsIdSchema,
  agentsUpdateSchema,
  parseIpcInput,
} from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

/** The agents-store operations (injected so the IPC layer is testable). */
export type AgentsIpcService = {
  listAgents(): AgentInfo[];
  createAgent(input: CreateAgentInput): AgentInfo;
  updateAgent(agentId: string, input: UpdateAgentInput): unknown;
  setAgentArchived(agentId: string, archived: boolean): unknown;
  deleteAgent(agentId: string): void;
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
    return service.createAgent({ ...definedFields(parsed), name: parsed.name });
  });

  ipc.handle(IPC_CHANNELS.agentsUpdate, (event, input) => {
    assertTrustedSender(event);
    const { id, ...fields } = parseIpcInput(agentsUpdateSchema, input, IPC_CHANNELS.agentsUpdate);
    service.updateAgent(id, definedFields(fields));
    return list();
  });

  ipc.handle(IPC_CHANNELS.agentsArchive, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(agentsArchiveSchema, input, IPC_CHANNELS.agentsArchive);
    service.setAgentArchived(parsed.id, parsed.archived);
    return list();
  });

  ipc.handle(IPC_CHANNELS.agentsDelete, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(agentsIdSchema, input, IPC_CHANNELS.agentsDelete);
    service.deleteAgent(parsed.id);
    return list();
  });
}
