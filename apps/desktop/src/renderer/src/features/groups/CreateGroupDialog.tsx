import { Dialog } from "@base-ui/react/dialog";
import { IconCrown, IconPlus, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AgentGroupWithMembers,
  GroupLeadRef,
  NewGroupAgentInput,
  UpdateAgentGroupMembersInput,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from "../../../../shared/group-blocked";
import { cn } from "../../lib/cn";
import { ModelOptions, pickModel } from "../../lib/modusModels";
import { describeGroupError } from "./groupErrors";
import { useGroupText } from "./groupRoomI18n";

/**
 * What "Manage members" sends, as ONE `group:update-members` call: new agents
 * to create, members to remove (removing a member deletes its agent) and the
 * final lead (a kept member or a new agent).
 */
export type GroupMembersChange = Omit<UpdateAgentGroupMembersInput, "groupId">;

/** Lead select value of a new (draft) agent; kept members use their session id. */
const newLeadValue = (key: number) => `new:${key}`;

/** A model offered for the new agents (a configured provider's). */
/** L3b0: `locked` = a Modus model not in the plan (listed, never selected; opens Buy credits). */
export type GroupDialogModel = {
  id: string;
  name: string;
  locked?: boolean | undefined;
  /** L3b: the smallest credit pack that unlocks a locked model (router unlock_pack). */
  unlockPack?: { id: string; credits: number } | undefined;
};

type CreateGroupDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Projects (to show the group's folder name). */
  workspaces: readonly WorkspaceInfo[];
  /** Models for the new agents (an agent without a template needs one). */
  models: readonly GroupDialogModel[];
  /** Preselected model (the app default). */
  defaultModelId?: string | undefined;
  /** "Manage members": add new agents, remove members and change the lead of `group`. */
  mode: "edit";
  group: AgentGroupWithMembers;
  onSave(change: GroupMembersChange): Promise<void>;
};

type DraftAgent = { key: number; name: string; role: string };

let draftKey = 0;
const draft = (): DraftAgent => ({ key: ++draftKey, name: "", role: "" });

const FIELD = cn(
  "h-8 w-full rounded-lg border border-hairline bg-canvas px-2.5 text-sm text-fg outline-none",
  "transition-colors placeholder:text-fg-faint focus:border-hairline-strong",
);

/**
 * "Manage members": remove members (which deletes their agents; not below 2),
 * add new agents (up to 10) and pick the lead, in ONE `group:update-members`.
 * Creating a group is the A4 modal (NewGroupModal).
 */
export function CreateGroupDialog(props: CreateGroupDialogProps) {
  const { open, onOpenChange, workspaces, models } = props;
  const editGroup = props.group;
  const t = useGroupText();
  const [modelId, setModelId] = useState("");
  const [agents, setAgents] = useState<DraftAgent[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [lead, setLead] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const projects = useMemo(() => workspaces.filter((workspace) => !workspace.inbox), [workspaces]);

  // Reset only when the dialog opens (or switches group), not on every list refresh.
  const editGroupId = editGroup?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read at open time only.
  useEffect(() => {
    if (!open) return;
    const initialModel =
      props.defaultModelId && models.some((model) => model.id === props.defaultModelId)
        ? props.defaultModelId
        : (models.find((model) => !model.locked)?.id ?? "");
    setModelId(initialModel);
    setRemoved([]);
    setAgents([]);
    setLead(editGroup.leadSessionId ?? "");
    setBusy(false);
    setError(undefined);
  }, [open, editGroupId]);

  const kept = editGroup.members.filter((member) => !removed.includes(member.sessionId));
  const named = agents.filter((agent) => agent.name.trim());
  const total = kept.length + named.length;
  const names = [...kept.map((member) => member.name), ...named.map((agent) => agent.name.trim())];
  const duplicate = new Set(names.map((value) => value.toLocaleLowerCase())).size !== names.length;
  const needsModel = named.length > 0 && !modelId;
  // The FINAL state (like groupMembersUpdateCountError): 2..10, except that a
  // legacy group above 10 may shrink as long as nothing is added.
  const countOk = total >= GROUP_MIN_MEMBERS && (total <= GROUP_MAX_MEMBERS || named.length === 0);
  const canSubmit =
    !busy &&
    countOk &&
    !duplicate &&
    !needsModel &&
    agents.every((agent) => agent.name.trim() || !agent.role.trim());
  const canAddAgent = total < GROUP_MAX_MEMBERS;
  const projectName = editGroup.workspaceId
    ? (projects.find((project) => project.id === editGroup.workspaceId)?.displayName ??
      t("manage.unknownProject"))
    : t("manage.noFolder");
  const hint = duplicate
    ? t("hint.names")
    : total < GROUP_MIN_MEMBERS
      ? t("hint.min", { count: GROUP_MIN_MEMBERS })
      : !countOk
        ? t("hint.max", { count: GROUP_MAX_MEMBERS })
        : needsModel
          ? t("manage.modelRequired")
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
      const leadDraft = named.find((agent) => newLeadValue(agent.key) === lead);
      const keptLead = kept.find((member) => member.sessionId === lead);
      const nextLead: GroupLeadRef | null = keptLead
        ? { agentId: keptLead.agentId }
        : leadDraft
          ? { name: leadDraft.name.trim() }
          : null;
      await props.onSave({
        add: named.map(toMember),
        removeAgentIds: editGroup.members
          .filter((member) => removed.includes(member.sessionId))
          .map((member) => member.agentId),
        lead: nextLead,
      });
      onOpenChange(false);
    } catch (caught) {
      setError(describeGroupError(caught, t.locale));
    } finally {
      setBusy(false);
    }
  }

  const newLeadOptions = named.map((agent) => ({
    value: newLeadValue(agent.key),
    label: agent.name.trim(),
  }));
  const leadOptions = [
    ...kept.map((member) => ({ value: member.sessionId, label: member.name })),
    ...newLeadOptions,
  ];

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
          initialFocus
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="px-4 pt-3.5 pb-1">
              <Dialog.Title className="font-medium text-fg text-sm">
                {t("manage.title")}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 truncate text-2xs text-fg-faint">
                {`${editGroup.name} · ${projectName}`}
              </Dialog.Description>
            </div>

            <div className="flex flex-col gap-3 px-4 pt-2">
              <fieldset className="flex min-w-0 flex-col gap-1">
                <legend className="mb-1 text-2xs text-fg-subtle">{t("manage.agents")}</legend>
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
                        aria-label={t("common.remove", { name: member.name })}
                        className="rounded p-1 text-fg-faint hover:bg-hover hover:text-fg disabled:opacity-40"
                        disabled={kept.length + named.length <= GROUP_MIN_MEMBERS}
                        onClick={() => {
                          setRemoved((current) => [...current, member.sessionId]);
                          if (lead === member.sessionId) setLead("");
                        }}
                        title={t("manage.removeTitle")}
                        type="button"
                      >
                        <IconX size={12} />
                      </button>
                    </li>
                  ))}
                  {agents.map((agent, index) => (
                    <li className="flex items-center gap-1.5" key={agent.key}>
                      <input
                        aria-label={t("manage.agentName", { index: index + 1 })}
                        className={FIELD}
                        maxLength={80}
                        onChange={(event) => updateAgent(agent.key, { name: event.target.value })}
                        placeholder={t("manage.namePlaceholder")}
                        value={agent.name}
                      />
                      <input
                        aria-label={t("manage.agentRole", { index: index + 1 })}
                        className={FIELD}
                        maxLength={80}
                        onChange={(event) => updateAgent(agent.key, { role: event.target.value })}
                        placeholder={t("manage.rolePlaceholder")}
                        value={agent.role}
                      />
                      <button
                        aria-label={t("manage.removeAgent", { index: index + 1 })}
                        className="rounded p-1 text-fg-faint hover:bg-hover hover:text-fg"
                        onClick={() => {
                          setAgents((current) => current.filter((item) => item.key !== agent.key));
                          if (lead === newLeadValue(agent.key)) setLead("");
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
                  {t("room.addAgent")}
                </button>
              </fieldset>

              {agents.length > 0 ? (
                <label className="flex flex-col gap-1">
                  <span className="text-2xs text-fg-subtle">{t("manage.modelForNew")}</span>
                  <select
                    className={cn(FIELD, "px-2")}
                    onChange={(event) => pickModel(models, event.target.value, setModelId)}
                    value={modelId}
                  >
                    {models.length === 0 ? (
                      <option value="">{t("common.noModelConfigured")}</option>
                    ) : null}
                    <ModelOptions locale={t.locale} models={models} />
                  </select>
                </label>
              ) : null}

              <label className="flex flex-col gap-1">
                <span className="flex items-center gap-1 text-2xs text-fg-subtle">
                  <IconCrown size={12} stroke={1.7} />
                  {t("common.lead")}
                </span>
                <select
                  className={cn(FIELD, "px-2 disabled:opacity-50")}
                  disabled={leadOptions.length === 0}
                  onChange={(event) => setLead(event.target.value)}
                  value={leadOptions.some((option) => option.value === lead) ? lead : ""}
                >
                  <option value="">{t("manage.noLead")}</option>
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
                {t("common.cancel")}
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
                {busy ? t("manage.saving") : t("manage.save")}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
