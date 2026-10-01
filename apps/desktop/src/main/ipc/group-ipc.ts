import type {
  AgentGroupMode,
  AgentGroupWithMembers,
  CreateAgentGroupInput,
  GroupDecision,
  GroupProjectContextSnapshot,
  GroupTask,
  NewGroupAgentInput,
  UpdateAgentGroupMembersInput,
} from "../../shared/contracts";
import {
  groupBlockedReason,
  groupCreateCountError,
  groupMemberCountError,
  groupMembersUpdateCountError,
} from "../../shared/group-blocked";
import { encodeGroupErrorMessage, isGroupErrorCode } from "../../shared/group-errors";
import {
  getGroupProjectContextSnapshot,
  scheduleGroupProjectSetup,
} from "../groups/group-project-setup";
import { ensureGroupProjectSetupBridge } from "../groups/group-runtime-service";
import { requireAgentModel } from "./agent-model-rule";
import { IPC_CHANNELS } from "./channels";
import {
  groupCancelTaskSchema,
  groupCreateSchema,
  groupDeleteDecisionSchema,
  groupIdInputSchema,
  groupListDecisionsSchema,
  groupListTasksSchema,
  groupMemberSchema,
  groupRemoveMemberSchema,
  groupRenameSchema,
  groupSetLeadSchema,
  groupSetModeSchema,
  groupSetWorkspaceSchema,
  groupUpdateMembersSchema,
  parseIpcInput,
} from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";
import { z } from "zod";

/** Local schema so we do not enlarge the shared schemas monolith for one channel. */
const groupProjectContextSchema = z.object({ workspaceId: z.string().min(1).max(128) }).strict();

/** The group-store operations the sidebar needs (injected so the IPC layer is testable). */
export type GroupIpcService = {
  listAgentGroupsWithMembers(): AgentGroupWithMembers[];
  /** Creates the group with 2..10 NEW agents (one group per agent). */
  createAgentGroupWithMembers(input: CreateAgentGroupInput): AgentGroupWithMembers;
  /** Whether `modelId` belongs to a configured provider (the agent model rule). */
  isModelAvailable(modelId: string): boolean;
  renameAgentGroup(groupId: string, name: string): unknown;
  /** Resolves once the sessions are torn down (after the store commit). */
  deleteAgentGroup(groupId: string): void | Promise<void>;
  /** Adds an ungrouped (legacy) agent; new agents join with `agents:create`. */
  addAgentGroupMember(input: { groupId: string; agentId: string; role?: string }): unknown;
  /** Removing a member deletes its agent (`group-min-members` when 2 are left). */
  removeAgentGroupMember(groupId: string, sessionId: string): void | Promise<void>;
  setAgentGroupLead(groupId: string, sessionId: string | null): unknown;
  /** The room menu's "Coordinator mode" toggle (PR 7). */
  setAgentGroupMode(groupId: string, mode: AgentGroupMode): unknown;
  /** Moves the group (and its room sessions) to another Project; never to none. */
  setAgentGroupWorkspace(groupId: string, workspaceId: string | null): unknown;
  /** "Manage members": adds, removes and lead in ONE transaction (final-state rules). */
  updateAgentGroupMembers(
    input: UpdateAgentGroupMembersInput,
  ): AgentGroupWithMembers | Promise<AgentGroupWithMembers>;
  listGroupTasks(groupId: string): GroupTask[];
  /** The room's "Cancel task" (the only path to `cancelled`). */
  cancelGroupTask(taskId: string): GroupTask;
  /** The side panel's "Decisions" (newest first). */
  listGroupDecisions(groupId: string): GroupDecision[];
  /** The side panel's "Delete" (physical; posts nothing). Only the user deletes decisions. */
  deleteGroupDecision(decisionId: string): GroupDecision;
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

/** `group-project-required` (groupBlockedReason's folder rule) before touching the store. */
function requireProject(workspaceId: string | null): void {
  if (groupBlockedReason({ workspaceId }, Number.POSITIVE_INFINITY) === "project-required") {
    throw new Error(
      encodeGroupErrorMessage("group-project-required", "A group needs a Project (folder)."),
    );
  }
}

/** The shared 2..10 rule (groupMemberCountError) for a change from `current` to `next`. */
function requireMemberCount(current: number, next: number): void {
  throwCountError(groupMemberCountError(current, next));
}

function throwCountError(code: "group-min-members" | "group-max-members" | null): void {
  if (code === "group-min-members") {
    throw new Error(encodeGroupErrorMessage(code, "A group needs at least 2 agents."));
  }
  if (code === "group-max-members") {
    throw new Error(encodeGroupErrorMessage(code, "A group can have at most 10 agents."));
  }
}

/** Only the fields present in a parsed member (exactOptionalPropertyTypes). */
function definedMemberFields(
  member: Record<string, unknown> & { name: string },
): NewGroupAgentInput {
  return Object.fromEntries(
    Object.entries(member).filter(([, value]) => value !== undefined),
  ) as NewGroupAgentInput;
}

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

/**
 * `group:*` handlers. Every mutation except create returns the refreshed group
 * list (like `workspace:pin`/`workspace:rename`), so the sidebar replaces its
 * state in one step. `group:create` returns the created group.
 *
 * Create / add / update make one hidden room session per group+agent pair
 * inside the store's transaction, so a rollback leaves nothing behind.
 */
export function registerGroupIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: GroupIpcService,
): void {
  const list = () => service.listAgentGroupsWithMembers();
  /** Current member count (archived agents included); unknown group → the store answers. */
  const memberCount = (groupId: string) =>
    list().find((group) => group.id === groupId)?.members.length;
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
    requireProject(parsed.workspaceId);
    throwCountError(groupCreateCountError(parsed.members.length));
    for (const member of parsed.members) requireAgentModel(service.isModelAvailable, member);
    const created = service.createAgentGroupWithMembers({
      name: parsed.name,
      workspaceId: parsed.workspaceId,
      ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      members: parsed.members.map((member) => definedMemberFields(member)),
      ...(parsed.leadName !== undefined ? { leadName: parsed.leadName } : {}),
    });
    if (created.workspaceId) {
      ensureGroupProjectSetupBridge();
      scheduleGroupProjectSetup({
        workspaceId: created.workspaceId,
        groupId: created.id,
        reason: "group_create",
      });
    }
    return created;
  });

  ipc.handle(IPC_CHANNELS.groupSetWorkspace, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupSetWorkspaceSchema, input, IPC_CHANNELS.groupSetWorkspace);
    requireProject(parsed.workspaceId);
    service.setAgentGroupWorkspace(parsed.groupId, parsed.workspaceId);
    if (parsed.workspaceId) {
      ensureGroupProjectSetupBridge();
      scheduleGroupProjectSetup({
        workspaceId: parsed.workspaceId,
        groupId: parsed.groupId,
        reason: "workspace_move",
      });
    }
    return list();
  });

  ipc.handle(IPC_CHANNELS.groupProjectContext, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      groupProjectContextSchema,
      input,
      IPC_CHANNELS.groupProjectContext,
    );
    requireProject(parsed.workspaceId);
    ensureGroupProjectSetupBridge();
    // Reopen: reuse Ready when fingerprint still matches; otherwise refresh.
    scheduleGroupProjectSetup({
      workspaceId: parsed.workspaceId,
      reason: "reopen",
    });
    return (getGroupProjectContextSnapshot(parsed.workspaceId) ??
      null) as GroupProjectContextSnapshot | null;
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
    return Promise.resolve(service.deleteAgentGroup(parsed.id)).then(list);
  });

  ipc.handle(IPC_CHANNELS.groupAddMember, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupMemberSchema, input, IPC_CHANNELS.groupAddMember);
    const count = memberCount(parsed.groupId);
    if (count !== undefined) requireMemberCount(count, count + 1);
    service.addAgentGroupMember({
      groupId: parsed.groupId,
      agentId: parsed.agentId,
      ...(parsed.role ? { role: parsed.role } : {}),
    });
    return list();
  });

  ipc.handle(IPC_CHANNELS.groupRemoveMember, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupRemoveMemberSchema, input, IPC_CHANNELS.groupRemoveMember);
    const group = list().find((row) => row.id === parsed.groupId);
    if (group?.members.some((member) => member.sessionId === parsed.sessionId)) {
      requireMemberCount(group.members.length, group.members.length - 1);
    }
    return Promise.resolve(service.removeAgentGroupMember(parsed.groupId, parsed.sessionId)).then(
      list,
    );
  });

  ipc.handle(IPC_CHANNELS.groupUpdateMembers, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupUpdateMembersSchema, input, IPC_CHANNELS.groupUpdateMembers);
    // The final count (the store checks it again inside its transaction).
    const count = memberCount(parsed.groupId);
    if (count !== undefined) {
      throwCountError(
        groupMembersUpdateCountError(count, parsed.add.length, parsed.removeAgentIds.length),
      );
    }
    for (const member of parsed.add) requireAgentModel(service.isModelAvailable, member);
    const done = service.updateAgentGroupMembers({
      groupId: parsed.groupId,
      add: parsed.add.map((member) => definedMemberFields(member)),
      removeAgentIds: parsed.removeAgentIds,
      lead: parsed.lead,
    });
    return Promise.resolve(done).then(list);
  });

  // The room's task panel: list a group's tasks; "Cancel task" returns the task.
  ipc.handle(IPC_CHANNELS.groupListTasks, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupListTasksSchema, input, IPC_CHANNELS.groupListTasks);
    return service.listGroupTasks(parsed.groupId);
  });

  ipc.handle(IPC_CHANNELS.groupCancelTask, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupCancelTaskSchema, input, IPC_CHANNELS.groupCancelTask);
    return service.cancelGroupTask(parsed.taskId);
  });

  // The side panel's decisions (PR 6). User only: members have no delete tool, and the
  // strict schema refuses a payload that names a (member) session.
  ipc.handle(IPC_CHANNELS.groupListDecisions, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupListDecisionsSchema, input, IPC_CHANNELS.groupListDecisions);
    return service.listGroupDecisions(parsed.groupId);
  });

  ipc.handle(IPC_CHANNELS.groupDeleteDecision, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      groupDeleteDecisionSchema,
      input,
      IPC_CHANNELS.groupDeleteDecision,
    );
    return service.deleteGroupDecision(parsed.decisionId);
  });

  ipc.handle(IPC_CHANNELS.groupSetLead, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupSetLeadSchema, input, IPC_CHANNELS.groupSetLead);
    service.setAgentGroupLead(parsed.groupId, parsed.sessionId);
    return list();
  });

  ipc.handle(IPC_CHANNELS.groupSetMode, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupSetModeSchema, input, IPC_CHANNELS.groupSetMode);
    service.setAgentGroupMode(parsed.groupId, parsed.mode);
    return list();
  });
}
