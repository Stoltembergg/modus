import { Dialog } from "@base-ui/react/dialog";
import { IconCrown, IconPlus, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_TEMPLATES,
  type AgentTemplate,
  agentAvatarForId,
} from "../../../../shared/agent-templates";
import type {
  AgentGroupWithMembers,
  AgentInfo,
  CreateAgentGroupInput,
  GenerateAgentProfileInput,
  GeneratedAgentProfile,
  NewGroupAgentInput,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from "../../../../shared/group-blocked";
import type { GroupTextKey } from "../../../../shared/group-room-locale";
import { cn } from "../../lib/cn";
import { AgentAvatar } from "../agents/AgentAvatar";
import { AgentDialog, type AgentDialogDraftTarget } from "../agents/AgentDialog";
import type { GroupDialogModel } from "./CreateGroupDialog";
import { describeGroupError } from "./groupErrors";
import { useGroupText } from "./groupRoomI18n";
import {
  applyCollabPipeline,
  assignNewGroupAvatarShapes,
  copyMember,
  dialogMember,
  type NewGroupMember,
  newGroupBlocker,
  newGroupCounter,
  newGroupCreateInput,
  newGroupDefaultName,
  templateMember,
} from "./newGroupModel";

/** Folder select value that runs the existing "Add folder…" flow. */
const ADD_FOLDER = "__add_folder__";

type Tab = "templates" | "copy" | "custom";

const TABS: readonly { id: Tab; label: GroupTextKey }[] = [
  { id: "templates", label: "newGroup.tabTemplates" },
  { id: "copy", label: "newGroup.tabCopy" },
  { id: "custom", label: "newGroup.tabCustom" },
];

const SOURCE_LABEL: Record<NewGroupMember["source"], GroupTextKey> = {
  template: "newGroup.sourceTemplate",
  copy: "newGroup.sourceCopy",
  custom: "newGroup.sourceCustom",
};

const FIELD = cn(
  "h-8 w-full rounded-lg border border-hairline bg-canvas px-2.5 text-sm text-fg outline-none",
  "transition-colors placeholder:text-fg-faint focus:border-hairline-strong",
);

/** What the modal needs from the app besides `group:create` (no new IPC). */
export type NewGroupServices = {
  /** `agents:list`: the other groups' agents for "Copy from another group". */
  listAgents(): Promise<AgentInfo[]>;
  /** The existing "Add folder…" flow (system folder picker → Project); null when cancelled. */
  addFolder(): Promise<WorkspaceInfo | null>;
  /** `agents:generate-profile` (A3), without a group: `roles` carries the modal's. */
  generateProfile(input: GenerateAgentProfileInput): Promise<GeneratedAgentProfile>;
};

export type NewGroupModalProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Projects for the folder picker (the Chats inbox is never offered). */
  workspaces: readonly WorkspaceInfo[];
  /** Folder preselected when it is a Project (usually the active one). */
  defaultWorkspaceId?: string | null;
  /** Existing groups (names for the copy tab). */
  groups: readonly AgentGroupWithMembers[];
  models: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  /** ONE `group:create`; rejects so the modal can show the error and stay open. */
  onCreate(input: CreateAgentGroupInput): Promise<void>;
  services: NewGroupServices;
};

type AgentDialogState = { initial?: NewGroupAgentInput; lead?: boolean } | null;

/**
 * "New group" (A4). Folder first (required; Projects plus "Add folder…",
 * never Chats), then members from three tabs: template cards (multi-select,
 * repeatable: "Builder 2"; Customize opens the agent dialog first), copies of
 * other groups' agents (normal members, no templateId) and new custom agents
 * (Generate, then Add). A `suggestedLead` template becomes the Lead unless one
 * is set. The footer counts N/10; Create sends ONE `group:create` with every
 * member and shows A2 errors inline, keeping the modal open. Render it only
 * while open: each open starts from a fresh draft.
 */
export function NewGroupModal({
  open,
  onOpenChange,
  workspaces,
  defaultWorkspaceId = null,
  groups,
  models,
  defaultModelId,
  onCreate,
  services,
}: NewGroupModalProps) {
  const t = useGroupText();
  const [addedProjects, setAddedProjects] = useState<WorkspaceInfo[]>([]);
  const projects = useMemo(() => {
    const list = workspaces.filter((workspace) => !workspace.inbox);
    for (const added of addedProjects) {
      if (!list.some((project) => project.id === added.id)) list.push(added);
    }
    return list;
  }, [workspaces, addedProjects]);
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState(() =>
    defaultWorkspaceId && workspaces.some((w) => w.id === defaultWorkspaceId && !w.inbox)
      ? defaultWorkspaceId
      : "",
  );
  const [tab, setTab] = useState<Tab>("templates");
  const [members, setMembers] = useState<NewGroupMember[]>([]);
  const [leadKey, setLeadKey] = useState<string | null>(null);
  const [agentDialog, setAgentDialog] = useState<AgentDialogState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [folderError, setFolderError] = useState<string | undefined>();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | undefined>();
  const keySeq = useRef(0);
  const nextKey = () => {
    keySeq.current += 1;
    return `m${keySeq.current}`;
  };
  const fallbackModelId =
    defaultModelId && models.some((model) => model.id === defaultModelId)
      ? defaultModelId
      : (models[0]?.id ?? "");

  // biome-ignore lint/correctness/useExhaustiveDependencies: loaded once per open.
  useEffect(() => {
    let cancelled = false;
    services.listAgents().then(
      (list) => {
        if (!cancelled) setAgents(list);
      },
      (caught: unknown) => {
        if (!cancelled) {
          setAgents([]);
          setAgentsError(describeGroupError(caught, t.locale));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  function add(member: NewGroupMember, lead: boolean): void {
    setMembers((current) => assignNewGroupAvatarShapes([...current, member]));
    if (lead) setLeadKey((current) => current ?? member.key);
    setError(undefined);
  }

  function addTemplate(template: AgentTemplate): void {
    add(templateMember(template, members, nextKey()), template.suggestedLead === true);
  }

  function addCollabPipeline(): void {
    setMembers((current) => {
      const next = assignNewGroupAvatarShapes(
        applyCollabPipeline(AGENT_TEMPLATES, current, nextKey),
      );
      const planner = next.find((member) => member.templateId === "planner");
      if (planner) setLeadKey((lead) => lead ?? planner.key);
      return next;
    });
    setError(undefined);
  }

  function remove(key: string): void {
    setMembers((current) =>
      assignNewGroupAvatarShapes(current.filter((member) => member.key !== key)),
    );
    if (leadKey === key) setLeadKey(null);
  }

  function update(key: string, patch: Partial<NewGroupMember>): void {
    setMembers((current) =>
      current.map((member) => (member.key === key ? { ...member, ...patch } : member)),
    );
  }

  async function chooseFolder(value: string): Promise<void> {
    setFolderError(undefined);
    if (value !== ADD_FOLDER) {
      setWorkspaceId(value);
      return;
    }
    try {
      const workspace = await services.addFolder();
      if (!workspace || workspace.inbox) return;
      setAddedProjects((current) => [...current, workspace]);
      setWorkspaceId(workspace.id);
    } catch (caught) {
      setFolderError(describeGroupError(caught, t.locale));
    }
  }

  const blocker = newGroupBlocker({ workspaceId, members }, t.locale);
  const canCreate = !busy && blocker === null;
  const overLimit = members.length > GROUP_MAX_MEMBERS;
  const countByTemplate = useMemo(() => {
    const counts = new Map<string, number>();
    for (const member of members) {
      if (member.templateId)
        counts.set(member.templateId, (counts.get(member.templateId) ?? 0) + 1);
    }
    return counts;
  }, [members]);
  const groupNames = useMemo(
    () => new Map(groups.map((group) => [group.id, group.name])),
    [groups],
  );
  const copyable = useMemo(
    () =>
      (agents ?? [])
        .filter((agent) => agent.groupId && groupNames.has(agent.groupId) && !agent.archivedAt)
        .sort(
          (a, b) =>
            (groupNames.get(a.groupId ?? "") ?? "").localeCompare(
              groupNames.get(b.groupId ?? "") ?? "",
            ) || a.name.localeCompare(b.name),
        ),
    [agents, groupNames],
  );

  async function submit(): Promise<void> {
    if (!canCreate) return;
    setBusy(true);
    setError(undefined);
    try {
      // Same locale as the placeholder: `undefined` (no room locale) → `null` = renderer locale.
      await onCreate(
        newGroupCreateInput({ name, workspaceId, members, leadKey }, t.locale ?? null),
      );
      onOpenChange(false);
    } catch (caught) {
      setError(describeGroupError(caught, t.locale));
    } finally {
      setBusy(false);
    }
  }

  const dialogTarget: AgentDialogDraftTarget | null = agentDialog
    ? {
        title: name.trim() || newGroupDefaultName(t.locale),
        takenNames: members.map((member) => member.name),
        roles: members.map((member) => member.role),
        takenAvatarShapes: members.flatMap((member) =>
          member.avatarShape ? [member.avatarShape] : [],
        ),
        seed: `new-group:${keySeq.current + 1}`,
        ...(agentDialog.initial ? { initial: agentDialog.initial } : {}),
        onAdd: (input) =>
          add(
            dialogMember(
              input,
              members,
              nextKey(),
              agentAvatarForId(`new-group:${keySeq.current + 1}`),
            ),
            agentDialog.lead === true,
          ),
      }
    : null;

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
            "-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 flex h-[min(620px,calc(100vh-2rem))] w-[min(780px,calc(100vw-2rem))] flex-col",
            "origin-center overflow-hidden popup-chrome outline-none",
            "transition-[transform,opacity,scale] duration-150 ease-out-quint motion-reduce:transition-none",
            "data-ending-style:scale-[0.96] data-ending-style:opacity-0",
            "data-starting-style:scale-[0.96] data-starting-style:opacity-0",
          )}
          data-testid="new-group-modal"
        >
          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="px-4 pt-3.5 pb-1">
              <Dialog.Title className="font-medium text-fg text-sm">
                {t("newGroup.title")}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-2xs text-fg-faint">
                {t("newGroup.description")}
              </Dialog.Description>
            </div>

            <div className="grid grid-cols-2 gap-2 px-4 pt-2">
              <label className="flex flex-col gap-1">
                <span className="text-2xs text-fg-subtle">{t("newGroup.folder")}</span>
                <select
                  className={cn(FIELD, "px-2")}
                  onChange={(event) => void chooseFolder(event.target.value)}
                  value={workspaceId}
                >
                  <option disabled value="">
                    {t("newGroup.chooseFolder")}
                  </option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.displayName}
                    </option>
                  ))}
                  <option value={ADD_FOLDER}>{t("newGroup.addFolder")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-2xs text-fg-subtle">{t("newGroup.name")}</span>
                <input
                  className={FIELD}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={newGroupDefaultName(t.locale)}
                  value={name}
                />
              </label>
            </div>
            {folderError ? (
              <p className="px-4 pt-1 text-2xs text-danger" role="alert">
                {folderError}
              </p>
            ) : null}

            <div className="mt-3 flex gap-1 border-hairline-soft border-b px-4" role="tablist">
              {TABS.map((item) => (
                <button
                  aria-selected={tab === item.id}
                  className={cn(
                    "-mb-px h-8 border-b-2 px-2 text-xs transition-colors",
                    tab === item.id
                      ? "border-accent text-fg"
                      : "border-transparent text-fg-subtle hover:text-fg",
                  )}
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  role="tab"
                  type="button"
                >
                  {t(item.label)}
                </button>
              ))}
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[1fr_260px]">
              <div className="scroll-thin min-h-0 overflow-y-auto p-3" role="tabpanel">
                {tab === "templates" ? (
                  <div className="space-y-2">
                    <button
                      className="h-7 w-full rounded-lg border border-hairline bg-canvas px-2.5 text-left text-2xs text-fg-muted transition-colors hover:border-hairline-strong hover:text-fg"
                      data-testid="collab-pipeline"
                      onClick={() => addCollabPipeline()}
                      type="button"
                    >
                      {t("newGroup.collabPipeline")}
                    </button>
                    <ul className="grid grid-cols-2 gap-2">
                      {AGENT_TEMPLATES.map((template) => {
                        const count = countByTemplate.get(template.id) ?? 0;
                        return (
                          <li
                            aria-label={template.name}
                            className={cn(
                              "flex flex-col gap-2 rounded-lg border p-2.5 transition-colors",
                              count > 0 ? "border-accent bg-accent/5" : "border-hairline",
                            )}
                            data-selected={count > 0 || undefined}
                            data-testid={`template-card-${template.id}`}
                            key={template.id}
                          >
                            <div className="flex items-start gap-2.5">
                              <AgentAvatar
                                color={template.avatarColor}
                                face={template.avatarFace}
                                shape={agentAvatarForId(template.id).avatarShape}
                                seed={template.id}
                                size={48}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate font-medium text-fg text-xs">
                                    {template.name}
                                  </span>
                                  {template.suggestedLead ? (
                                    <IconCrown
                                      aria-label={t("newGroup.suggestedLead")}
                                      className="text-amber-400"
                                      size={12}
                                    />
                                  ) : null}
                                  {count > 0 ? (
                                    <span className="ml-auto rounded bg-accent/15 px-1 text-2xs text-accent">
                                      ×{count}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="text-2xs text-fg-subtle">{template.role}</div>
                                <p className="mt-0.5 line-clamp-2 text-2xs text-fg-faint">
                                  {template.description}
                                </p>
                              </div>
                            </div>
                            <div className="flex justify-end gap-1">
                              <button
                                aria-label={t("newGroup.customizeLabel", { name: template.name })}
                                className="h-6 rounded-md px-2 text-2xs text-fg-subtle hover:bg-hover hover:text-fg"
                                onClick={() =>
                                  setAgentDialog({
                                    initial: {
                                      templateId: template.id,
                                      name: templateMember(template, members, "preview").name,
                                      role: template.role,
                                      instructions: template.instructions,
                                      avatarFace: template.avatarFace,
                                      avatarColor: template.avatarColor,
                                    },
                                    lead: template.suggestedLead === true,
                                  })
                                }
                                type="button"
                              >
                                {t("newGroup.customize")}
                              </button>
                              <button
                                aria-label={t("newGroup.addLabel", { name: template.name })}
                                className="flex h-6 items-center gap-1 rounded-md bg-chip px-2 text-2xs text-fg hover:bg-chip-strong"
                                onClick={() => addTemplate(template)}
                                type="button"
                              >
                                <IconPlus size={11} />
                                {t("newGroup.add")}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : tab === "copy" ? (
                  <div className="flex flex-col gap-1">
                    <p className="mb-1 text-2xs text-fg-faint">{t("newGroup.copyHint")}</p>
                    {agents === null ? (
                      <p className="text-xs text-fg-faint">{t("newGroup.loadingAgents")}</p>
                    ) : agentsError ? (
                      <p className="text-xs text-danger" role="alert">
                        {agentsError}
                      </p>
                    ) : copyable.length === 0 ? (
                      <p className="text-xs text-fg-faint">{t("newGroup.noCopyable")}</p>
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {copyable.map((agent) => {
                          const groupName = groupNames.get(agent.groupId ?? "") ?? "";
                          return (
                            <li
                              className="flex h-9 items-center gap-2 rounded-md px-1.5 hover:bg-hover"
                              key={agent.id}
                            >
                              <AgentAvatar
                                color={agent.avatarColor}
                                face={agent.avatarFace}
                                shape={agent.avatarShape}
                                seed={agent.id}
                                size={20}
                              />
                              <span className="min-w-0 flex-1 truncate text-xs text-fg">
                                {agent.name}
                                {agent.role ? (
                                  <span className="text-fg-faint"> · {agent.role}</span>
                                ) : null}
                              </span>
                              <span className="max-w-28 truncate text-2xs text-fg-faint">
                                {groupName}
                              </span>
                              <button
                                aria-label={t("newGroup.copyLabel", {
                                  name: agent.name,
                                  group: groupName,
                                })}
                                className="h-6 rounded-md bg-chip px-2 text-2xs text-fg hover:bg-chip-strong"
                                onClick={() =>
                                  add(copyMember(agent, members, nextKey(), fallbackModelId), false)
                                }
                                type="button"
                              >
                                {t("newGroup.copy")}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-start gap-2 text-xs text-fg-subtle">
                    <p>{t("newGroup.customHint")}</p>
                    <button
                      className="flex h-7 items-center gap-1 rounded-md bg-accent px-3 text-white text-xs hover:opacity-90"
                      onClick={() => setAgentDialog({})}
                      type="button"
                    >
                      <IconPlus size={12} />
                      {t("newGroup.newAgent")}
                    </button>
                  </div>
                )}
              </div>

              <section
                aria-label={t("newGroup.members")}
                className="scroll-thin flex min-h-0 flex-col gap-1 overflow-y-auto border-hairline-soft border-l p-3"
              >
                <h3 className="mb-1 text-2xs text-fg-subtle">{t("newGroup.members")}</h3>
                {members.length === 0 ? (
                  <p className="text-2xs text-fg-faint">
                    {t("newGroup.addAtLeast", { count: GROUP_MIN_MEMBERS })}
                  </p>
                ) : null}
                <ul className="flex flex-col gap-1">
                  {members.map((member, index) => {
                    const isLead = member.key === leadKey;
                    const label =
                      member.name.trim() || t("newGroup.memberFallback", { index: index + 1 });
                    return (
                      <li
                        className="flex flex-col gap-1 rounded-md border border-hairline-soft p-1.5"
                        data-testid="new-group-member"
                        key={member.key}
                      >
                        <div className="flex items-center gap-1.5">
                          <AgentAvatar
                            color={member.avatarColor}
                            face={member.avatarFace}
                            shape={
                              member.avatarShape ??
                              agentAvatarForId(member.templateId ?? member.key).avatarShape
                            }
                            seed={member.key}
                            size={20}
                          />
                          <input
                            aria-label={t("newGroup.memberName", { index: index + 1 })}
                            className={cn(FIELD, "h-7 text-xs")}
                            maxLength={80}
                            onChange={(event) => update(member.key, { name: event.target.value })}
                            value={member.name}
                          />
                          <button
                            aria-label={
                              isLead
                                ? t("newGroup.isLead", { name: label })
                                : t("newGroup.makeLeadLabel", { name: label })
                            }
                            aria-pressed={isLead}
                            className={cn(
                              "rounded p-1 hover:bg-hover",
                              isLead ? "text-amber-400" : "text-fg-faint hover:text-fg",
                            )}
                            onClick={() => setLeadKey(isLead ? null : member.key)}
                            title={isLead ? t("newGroup.leadClear") : t("newGroup.makeLead")}
                            type="button"
                          >
                            <IconCrown size={12} />
                          </button>
                          <button
                            aria-label={t("common.remove", { name: label })}
                            className="rounded p-1 text-fg-faint hover:bg-hover hover:text-fg"
                            onClick={() => remove(member.key)}
                            type="button"
                          >
                            <IconX size={12} />
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5 pl-6 text-2xs text-fg-faint">
                          <span className="min-w-0 flex-1 truncate">
                            {member.role || t("newGroup.noRole")}
                          </span>
                          <span data-testid="new-group-member-source">
                            {t(SOURCE_LABEL[member.source])}
                          </span>
                        </div>
                        {!member.templateId && !member.modelId ? (
                          <select
                            aria-label={t("newGroup.modelOf", { name: label })}
                            className={cn(FIELD, "h-7 px-2 text-xs")}
                            onChange={(event) =>
                              update(member.key, { modelId: event.target.value })
                            }
                            value=""
                          >
                            <option disabled value="">
                              {models.length === 0
                                ? t("common.noModelConfigured")
                                : t("newGroup.chooseModel")}
                            </option>
                            {models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.name}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>

            {error ? (
              <div
                className="mx-4 mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/8 px-2.5 py-2 text-xs text-danger"
                role="alert"
              >
                {error}
              </div>
            ) : null}

            <div className="mt-2 flex items-center gap-2 border-hairline-soft border-t px-4 py-2.5">
              <span
                className={cn("text-xs tabular-nums", overLimit ? "text-danger" : "text-fg-subtle")}
                data-testid="new-group-counter"
              >
                {newGroupCounter(members.length)}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-2xs text-fg-faint"
                data-testid="new-group-hint"
              >
                {blocker ?? ""}
              </span>
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
                  canCreate
                    ? "bg-accent text-white hover:opacity-90"
                    : "cursor-not-allowed bg-chip-strong text-fg-faint",
                )}
                disabled={!canCreate}
                type="submit"
              >
                {busy ? t("newGroup.creating") : t("newGroup.create")}
              </button>
            </div>
          </form>

          {dialogTarget ? (
            <AgentDialog
              defaultModelId={defaultModelId}
              draft={dialogTarget}
              models={models}
              onGenerate={services.generateProfile}
              onOpenChange={(next) => {
                if (!next) setAgentDialog(null);
              }}
              open
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
