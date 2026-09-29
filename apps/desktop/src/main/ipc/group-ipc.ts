import type {
  AgentGroupWithMembers,
  CreateAgentGroupInput,
  UpdateAgentGroupMembersInput,
} from "../../shared/contracts";
import { encodeGroupErrorMessage, isGroupErrorCode } from "../../shared/group-errors";
import { IPC_CHANNELS } from "./channels";
import {
  groupCreateSchema,
  groupIdInputSchema,
  groupMemberSchema,
  groupRemoveMemberSchema,
  groupRenameSchema,
  groupSetLeadSchema,
  groupUpdateMembersSchema,
  parseIpcInput,
} from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

/** The group-store operations the sidebar needs (injected so the IPC layer is testable). */
export type GroupIpcService = {
  listAgentGroupsWithMembers(): AgentGroupWithMembers[];
  createAgentGroupWithMembers(input: CreateAgentGroupInput): AgentGroupWithMembers;
  renameAgentGroup(groupId: string, name: string): unknown;
  deleteAgentGroup(groupId: string): void;
  addAgentGroupMember(input: { groupId: string; sessionId: string; role?: string }): unknown;
  removeAgentGroupMember(groupId: string, sessionId: string): void;
  setAgentGroupLead(groupId: string, sessionId: string | null): unknown;
  updateAgentGroupMembers(
    groupId: string,
    input: Omit<UpdateAgentGroupMembersInput, "groupId">,
  ): AgentGroupWithMembers;
};

/**
 * Electron drops custom error properties across IPC (only `message` survives),
 * so a GroupStoreError's `code` is serialized into the message
 * (`[group-error:<code>] ...`, see shared/group-errors). Other errors pass
 * through untouched. Duck-typed so this module does not import the store.
 */
export function toGroupIpcError(error: unknown): unknown {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (error instanceof Error && error.name === "GroupStoreError" && isGroupErrorCode(code)) {
    return new Error(encodeGroupErrorMessage(code, error.message), { cause: error });
  }
  return error;
}

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

/**
 * `group:*` handlers. Every mutation except create returns the refreshed group
 * list (like `workspace:pin`/`workspace:rename`), so the sidebar replaces its
 * state in one step. `group:create` returns the created group.
 *
 * The create dialog only groups EXISTING sessions; it never creates sessions,
 * so there is nothing to clean up when the store's transaction rolls back.
 */
export function registerGroupIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: GroupIpcService,
): void {
  const list = () => service.listAgentGroupsWithMembers();
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

  ipc.handle(IPC_CHANNELS.groupList, (event, input) => {
    assertTrustedSender(event);
    if (input !== undefined) {
      throw new Error(`Invalid IPC payload for ${IPC_CHANNELS.groupList}: expected no input`);
    }
    return list();
  });

  ipc.handle(IPC_CHANNELS.groupCreate, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupCreateSchema, input, IPC_CHANNELS.groupCreate);
    return service.createAgentGroupWithMembers({
      name: parsed.name,
      ...(parsed.workspaceId !== undefined ? { workspaceId: parsed.workspaceId } : {}),
      ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      members: parsed.members.map((member) => ({
        sessionId: member.sessionId,
        ...(member.role ? { role: member.role } : {}),
      })),
      ...(parsed.leadSessionId !== undefined ? { leadSessionId: parsed.leadSessionId } : {}),
    });
  });

  ipc.handle(IPC_CHANNELS.groupRename, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupRenameSchema, input, IPC_CHANNELS.groupRename);
    service.renameAgentGroup(parsed.id, parsed.name);
    return list();
  });

  ipc.handle(IPC_CHANNELS.groupDelete, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupIdInputSchema, input, IPC_CHANNELS.groupDelete);
    service.deleteAgentGroup(parsed.id);
    return list();
  });

  ipc.handle(IPC_CHANNELS.groupAddMember, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupMemberSchema, input, IPC_CHANNELS.groupAddMember);
    service.addAgentGroupMember({
      groupId: parsed.groupId,
      sessionId: parsed.sessionId,
      ...(parsed.role ? { role: parsed.role } : {}),
    });
    return list();
  });

  ipc.handle(IPC_CHANNELS.groupRemoveMember, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupRemoveMemberSchema, input, IPC_CHANNELS.groupRemoveMember);
    service.removeAgentGroupMember(parsed.groupId, parsed.sessionId);
    return list();
  });

  ipc.handle(IPC_CHANNELS.groupUpdateMembers, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupUpdateMembersSchema, input, IPC_CHANNELS.groupUpdateMembers);
    service.updateAgentGroupMembers(parsed.groupId, {
      members: parsed.members.map((member) => ({
        sessionId: member.sessionId,
        ...(member.role ? { role: member.role } : {}),
      })),
      leadSessionId: parsed.leadSessionId,
    });
    return list();
  });

  ipc.handle(IPC_CHANNELS.groupSetLead, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupSetLeadSchema, input, IPC_CHANNELS.groupSetLead);
    service.setAgentGroupLead(parsed.groupId, parsed.sessionId);
    return list();
  });
}
