import { Dialog } from "@base-ui/react/dialog";
import { IconCrown, IconPlus, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentGroupWithMembers,
  CreateAgentGroupInput,
  NewGroupAgentInput,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from "../../../../shared/group-blocked";
import { cn } from "../../lib/cn";
import { describeGroupError } from "./groupErrors";

/** Select value while no Project is chosen (a group needs one: Create stays disabled). */
const NO_PROJECT = "";

/**
 * What "Manage members" sends: new agents to create in the group, members to
 * remove (removing a member deletes its agent) and the lead among the kept
 * members.
 */
export type GroupMembersChange = {
  add: NewGroupAgentInput[];
  removeSessionIds: string[];
  leadSessionId: string | null;
};

/** A model offered for the new agents (a configured provider's). */
export type GroupDialogModel = { id: string; name: string };

type DialogCommonProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Projects offered in the Project picker (the Chats inbox is excluded). */
  workspaces: readonly WorkspaceInfo[];
  /** Models for the new agents (an agent without a template needs one). */
  models: readonly GroupDialogModel[];
  /** Preselected model (the app default). */
  defaultModelId?: string | undefined;
};

type CreateModeProps = DialogCommonProps & {
  mode?: "create";
  /** Project preselected when the dialog opens (e.g. the active one). */
  defaultWorkspaceId?: string | null;
  onCreate(input: CreateAgentGroupInput): Promise<void>;
};

type EditModeProps = DialogCommonProps & {
  /** "Manage members": add new agents, remove members and change the lead of `group`. */
  mode: "edit";
  group: AgentGroupWithMembers;
  onSave(change: GroupMembersChange): Promise<void>;
};

type CreateGroupDialogProps = CreateModeProps | EditModeProps;

type DraftAgent = { key: number; name: string; role: string };

let draftKey = 0;
const draft = (): DraftAgent => ({ key: ++draftKey, name: "", role: "" });

const FIELD = cn(
  "h-8 w-full rounded-lg border border-hairline bg-canvas px-2.5 text-sm text-fg outline-none",
  "transition-colors placeholder:text-fg-faint focus:border-hairline-strong",
);

/**
 * Minimal "New group" dialog (the full modal is A4): name, Project (required),
 * model, 2..10 NEW agents (name + role; an agent belongs to one group) and the
 * lead. In `mode="edit"` it becomes "Manage members": remove members (which
 * deletes their agents; not below 2), add new agents (up to 10) and pick the lead.
 */
export function CreateGroupDialog(props: CreateGroupDialogProps) {
  const { open, onOpenChange, workspaces, models } = props;
  const editGroup = props.mode === "edit" ? props.group : undefined;
  const defaultWorkspaceId = props.mode === "edit" ? null : (props.defaultWorkspaceId ?? null);
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string>(NO_PROJECT);
  const [modelId, setModelId] = useState("");
  const [agents, setAgents] = useState<DraftAgent[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [lead, setLead] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const nameRef = useRef<HTMLInputElement>(null);

  const projects = useMemo(() => workspaces.filter((workspace) => !workspace.inbox), [workspaces]);

  // Reset only when the dialog opens (or switches group), not on every list refresh.
  const editGroupId = editGroup?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read at open time only.
  useEffect(() => {
    if (!open) return;
    const initialModel =
      props.defaultModelId && models.some((model) => model.id === props.defaultModelId)
        ? props.defaultModelId
        : (models[0]?.id ?? "");
    setModelId(initialModel);
    setRemoved([]);
    if (editGroup) {
      setName(editGroup.name);
      setWorkspaceId(editGroup.workspaceId ?? NO_PROJECT);
      setAgents([]);
      setLead(editGroup.leadSessionId ?? "");
    } else {
      setName("");
      setWorkspaceId(
        defaultWorkspaceId && projects.some((project) => project.id === defaultWorkspaceId)
          ? defaultWorkspaceId
          : NO_PROJECT,
      );
      setAgents([draft(), draft()]);
      setLead("");
    }
    setBusy(false);
    setError(undefined);
  }, [open, defaultWorkspaceId, projects, editGroupId]);

  const kept = editGroup
    ? editGroup.members.filter((member) => !removed.includes(member.sessionId))
    : [];
  const named = agents.filter((agent) => agent.name.trim());
  const total = kept.length + named.length;
  const names = [...kept.map((member) => member.name), ...named.map((agent) => agent.name.trim())];
  const duplicate = new Set(names.map((value) => value.toLocaleLowerCase())).size !== names.length;
  const needsModel = named.length > 0 && !modelId;
  const countOk = editGroup
    ? // Legacy groups outside 2..10 may shrink / grow back toward the range.
      (total >= GROUP_MIN_MEMBERS || total >= editGroup.members.length) &&
      (total <= GROUP_MAX_MEMBERS || total <= editGroup.members.length)
    : total >= GROUP_MIN_MEMBERS && total <= GROUP_MAX_MEMBERS;
  const canSubmit =
    !busy &&
    countOk &&
    !duplicate &&
    !needsModel &&
    agents.every((agent) => agent.name.trim() || !agent.role.trim()) &&
    (editGroup ? true : name.trim().length > 0 && workspaceId !== NO_PROJECT);
  const canAddAgent = total < GROUP_MAX_MEMBERS;
  const projectName = editGroup?.workspaceId
    ? (projects.find((project) => project.id === editGroup.workspaceId)?.displayName ??
      "Unknown project")
    : "No folder";
  const hint = duplicate
    ? "Each agent needs a different name."
    : total < GROUP_MIN_MEMBERS
      ? `A group needs at least ${GROUP_MIN_MEMBERS} agents.`
      : !editGroup && workspaceId === NO_PROJECT
        ? "Choose a project for the group."
        : needsModel
          ? "Choose a model for the new agents."
          : undefined;

  function updateAgent(key: number, patch: Partial<DraftAgent>): void {
    setAgents((current) =>
      current.map((agent) => (agent.key === key ? { ...agent, ...patch } : agent)),
    );
  }

  function toMember(agent: DraftAgent): NewGroupAgentInput {
    return {
      name: agent.name.trim(),
      ...(agent.role.trim() ? { role: agent.role.trim() } : {}),
      modelId,
    };
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    setError(undefined);
    try {
      if (props.mode === "edit") {
        const leadSessionId = kept.some((member) => member.sessionId === lead) ? lead : null;
        await props.onSave({
          add: named.map(toMember),
          removeSessionIds: removed,
          leadSessionId,
        });
      } else {
        const leadName = named.find((agent) => String(agent.key) === lead)?.name.trim();
        await props.onCreate({
          name: name.trim(),
          workspaceId,
          members: named.map(toMember),
          ...(leadName ? { leadName } : {}),
        });
      }
      onOpenChange(false);
    } catch (caught) {
      setError(describeGroupError(caught));
    } finally {
      setBusy(false);
    }
  }

  const leadOptions = editGroup
    ? kept.map((member) => ({ value: member.sessionId, label: member.name }))
    : named.map((agent) => ({ value: String(agent.key), label: agent.name.trim() }));

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 ease-out-quint motion-reduce:transition-none",
            "data-ending-style:opacity-0 data-starting-style:opacity-0",
          )}
        />
        <Dialog.Popup
          className={cn(
            "-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-2rem))]",
            "origin-center overflow-hidden popup-chrome outline-none",
            "transition-[transform,opacity,scale] duration-150 ease-out-quint motion-reduce:transition-none",
            "data-ending-style:scale-[0.96] data-ending-style:opacity-0",
            "data-starting-style:scale-[0.96] data-starting-style:opacity-0",
          )}
          initialFocus={editGroup ? true : nameRef}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="px-4 pt-3.5 pb-1">
              <Dialog.Title className="font-medium text-fg text-sm">
                {editGroup ? "Manage members" : "New group"}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 truncate text-2xs text-fg-faint">
                {editGroup
                  ? `${editGroup.name} · ${projectName}`
                  : "New agents that work together in one project."}
              </Dialog.Description>
            </div>

            <div className="flex flex-col gap-3 px-4 pt-2">
              {editGroup ? null : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-2xs text-fg-subtle">Name</span>
                    <input
                      className={FIELD}
                      maxLength={120}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="e.g. Release squad"
                      ref={nameRef}
                      value={name}
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-2xs text-fg-subtle">Project</span>
                    <select
                      className={cn(FIELD, "px-2")}
                      onChange={(event) => setWorkspaceId(event.target.value)}
                      value={workspaceId}
                    >
                      <option disabled value={NO_PROJECT}>
                        Choose a project
                      </option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}

              <fieldset className="flex min-w-0 flex-col gap-1">
                <legend className="mb-1 text-2xs text-fg-subtle">Agents</legend>
                <ul className="scroll-thin flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {kept.map((member) => (
                    <li
                      className="flex h-8 items-center gap-2 px-1 text-xs text-fg-muted"
                      key={member.sessionId}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {member.name}
                        {member.agentRole ? (
                          <span className="text-fg-faint"> · {member.agentRole}</span>
                        ) : null}
                      </span>
                      <button
                        aria-label={`Remove ${member.name}`}
                        className="rounded p-1 text-fg-faint hover:bg-hover hover:text-fg disabled:opacity-40"
                        disabled={kept.length + named.length <= GROUP_MIN_MEMBERS}
                        onClick={() => {
                          setRemoved((current) => [...current, member.sessionId]);
                          if (lead === member.sessionId) setLead("");
                        }}
                        title="Removing a member deletes its agent"
                        type="button"
                      >
                        <IconX size={12} />
                      </button>
                    </li>
                  ))}
                  {agents.map((agent, index) => (
                    <li className="flex items-center gap-1.5" key={agent.key}>
                      <input
                        aria-label={`Agent ${index + 1} name`}
                        className={FIELD}
                        maxLength={80}
                        onChange={(event) => updateAgent(agent.key, { name: event.target.value })}
                        placeholder="Name"
                        value={agent.name}
                      />
                      <input
                        aria-label={`Agent ${index + 1} role`}
                        className={FIELD}
                        maxLength={80}
                        onChange={(event) => updateAgent(agent.key, { role: event.target.value })}
                        placeholder="Role (optional)"
                        value={agent.role}
                      />
                      <button
                        aria-label={`Remove agent ${index + 1}`}
                        className="rounded p-1 text-fg-faint hover:bg-hover hover:text-fg"
                        onClick={() => {
                          setAgents((current) => current.filter((item) => item.key !== agent.key));
                          if (lead === String(agent.key)) setLead("");
                        }}
                        type="button"
                      >
                        <IconX size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  className="flex h-7 items-center gap-1 self-start rounded-md px-1.5 text-2xs text-fg-subtle hover:bg-hover hover:text-fg disabled:opacity-40"
                  disabled={!canAddAgent || agents.length + kept.length >= GROUP_MAX_MEMBERS}
                  onClick={() => setAgents((current) => [...current, draft()])}
                  type="button"
                >
                  <IconPlus size={12} />
                  Add agent
                </button>
              </fieldset>

              {agents.length > 0 ? (
                <label className="flex flex-col gap-1">
                  <span className="text-2xs text-fg-subtle">Model for new agents</span>
                  <select
                    className={cn(FIELD, "px-2")}
                    onChange={(event) => setModelId(event.target.value)}
                    value={modelId}
                  >
                    {models.length === 0 ? <option value="">No model configured</option> : null}
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <label className="flex flex-col gap-1">
                <span className="flex items-center gap-1 text-2xs text-fg-subtle">
                  <IconCrown size={12} stroke={1.7} />
                  Lead
                </span>
                <select
                  className={cn(FIELD, "px-2 disabled:opacity-50")}
                  disabled={leadOptions.length === 0}
                  onChange={(event) => setLead(event.target.value)}
                  value={leadOptions.some((option) => option.value === lead) ? lead : ""}
                >
                  <option value="">No lead</option>
                  {leadOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {hint ? <p className="text-2xs text-fg-faint">{hint}</p> : null}
            </div>

            {error ? (
              <div
                className="mx-4 mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/8 px-2.5 py-2 text-xs text-danger"
                role="alert"
              >
                {error}
              </div>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2 border-hairline-soft border-t px-4 py-2.5">
              <button
                className="h-7 rounded-md px-3 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                onClick={() => onOpenChange(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className={cn(
                  "h-7 rounded-md px-3 text-xs transition-colors",
                  canSubmit
                    ? "bg-accent text-white hover:opacity-90"
                    : "cursor-not-allowed bg-chip-strong text-fg-faint",
                )}
                disabled={!canSubmit}
                type="submit"
              >
                {editGroup
                  ? busy
                    ? "Saving…"
                    : "Save members"
                  : busy
                    ? "Creating…"
                    : "Create group"}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
