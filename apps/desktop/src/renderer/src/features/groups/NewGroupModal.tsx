import { Dialog } from "@base-ui/react/dialog";
import { IconCrown, IconPlus, IconX } from "@tabler/icons-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentAvatarSeed } from "../../../../shared/agent-avatar-seeds";
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
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { GROUP_MAX_MEMBERS } from "../../../../shared/group-blocked";
import type { GroupTextKey } from "../../../../shared/group-room-locale";
import { SelectControl } from "../../components/ui/SelectControl";
import { cn } from "../../lib/cn";
import { selectableModels } from "../../lib/modusModels";
import { motionOffset, motionTransition, tween } from "../../lib/motion";
import { AgentAvatar } from "../agents/AgentAvatar";
import { AgentDialog, type AgentDialogDraftTarget } from "../agents/AgentDialog";
import type { GroupDialogModel } from "./CreateGroupDialog";
import { describeGroupError } from "./groupErrors";
import { useGroupText } from "./groupRoomI18n";
import {
  applyCollabPipeline,
  assignNewGroupAvatarShapes,
  COLLAB_PIPELINE_IDS,
  copyMember,
  dialogMember,
  editedMember,
  leadAfterRemoval,
  membersFromCard,
  type NewGroupMember,
  newGroupBlocker,
  newGroupCounter,
  newGroupCreateInput,
  newGroupDefaultName,
  newGroupMemberInput,
  newGroupMemberSeed,
  nextFreeName,
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

const FIELD = cn(
  "h-8 w-full rounded-lg border border-hairline bg-canvas px-2.5 text-sm text-fg outline-none",
  "transition-colors placeholder:text-fg-faint focus:border-hairline-strong",
);

/** What the modal needs from the app besides `group:create` (no new IPC). */
export type NewGroupServices = {
  /** `agents:list`: the other groups' agents for "From another group". */
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

type AgentDialogRequest =
  | { type: "customize"; template: AgentTemplate }
  | { type: "custom" }
  | { type: "edit"; memberKey: string };

type AgentDialogState = (AgentDialogRequest & { nonce: number }) | null;

// Sits after the Added pill, so a hidden (non-lead) crown never pushes the pill away from the name.
function LeadCrownButton({
  member,
  isLead,
  onToggle,
  groupVariant = "card",
}: {
  member: { name: string; key: string };
  isLead: boolean;
  onToggle(): void;
  groupVariant?: "card" | "line";
}) {
  const t = useGroupText();
  return (
    <button
      aria-label={
        isLead
          ? t("newGroup.isLead", { name: member.name })
          : t("newGroup.makeLeadLabel", { name: member.name })
      }
      aria-pressed={isLead}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded p-1 transition-opacity",
        isLead
          ? "text-dialog-warning opacity-100"
          : groupVariant === "line"
            ? "text-fg-faint opacity-0 group-hover/line:opacity-100 group-focus-within/line:opacity-100 hover:text-fg"
            : "text-fg-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-fg",
      )}
      onClick={onToggle}
      title={isLead ? t("newGroup.leadClear") : t("newGroup.makeLead")}
      type="button"
    >
      <IconCrown size={14} />
    </button>
  );
}

/** Cards that can take focus back when the in-dialog panel closes. */
const CARD_SELECTOR =
  '[data-testid^="template-card-"], [data-testid^="member-card-"], [data-testid^="copy-card-"]';

/**
 * "New group" (A4 redesigned). Folder first (required; Projects plus "Add folder…",
 * never Chats), segmented control for full-width tab panels: Templates (with
 * inline member states and Collab pipeline suggestion), From another group,
 * and New agent. Members are customized or edited via an in-dialog panel (surface="plain").
 */
export function NewGroupModal({
  open,
  onOpenChange,
  workspaces,
  defaultWorkspaceId = null,
  groups,
  models: allModels,
  defaultModelId,
  onCreate,
  services,
}: NewGroupModalProps) {
  const t = useGroupText();
  const reduceMotion = useReducedMotion();
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
  const [agentDialog, setAgentDialogState] = useState<AgentDialogState>(null);
  const agentDialogSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [folderError, setFolderError] = useState<string | undefined>();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | undefined>();
  const models = selectableModels(allModels);
  const keySeq = useRef(0);
  const nextKey = () => {
    keySeq.current += 1;
    return `m${keySeq.current}`;
  };
  const fallbackModelId =
    defaultModelId && models.some((model) => model.id === defaultModelId) ? defaultModelId : "";

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
    // Built outside the state updater: StrictMode runs updaters twice, and keys
    // minted there would leave the lead pointing at a member that never landed.
    const next = assignNewGroupAvatarShapes(applyCollabPipeline(AGENT_TEMPLATES, members, nextKey));
    setMembers(next);
    const planner = next.find((member) => member.templateId === "planner");
    if (planner) setLeadKey((lead) => lead ?? planner.key);
    setError(undefined);
  }

  function remove(key: string): void {
    setLeadKey((lead) => leadAfterRemoval(members, key, lead));
    setMembers((current) =>
      assignNewGroupAvatarShapes(current.filter((member) => member.key !== key)),
    );
  }

  // Where the panel was opened from, so Back (or saving) returns focus there:
  // the list is unmounted while the panel shows, so we keep the button's label
  // and its card, and look them up again once the list is back.
  const popupRef = useRef<HTMLDivElement>(null);
  const panelOrigin = useRef<{ label: string | null; card: string | null } | null>(null);
  const rememberOrigin = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !popupRef.current?.contains(active)) {
      panelOrigin.current = null;
      return;
    }
    panelOrigin.current = {
      label: active.getAttribute("aria-label") ?? active.textContent?.trim() ?? null,
      card: active.closest<HTMLElement>(CARD_SELECTOR)?.dataset.testid ?? null,
    };
  };
  const openCustomize = (template: AgentTemplate) => {
    rememberOrigin();
    setAgentDialogState({ type: "customize", template, nonce: ++agentDialogSeq.current });
  };
  const openCustom = () => {
    rememberOrigin();
    setAgentDialogState({ type: "custom", nonce: ++agentDialogSeq.current });
  };
  const openEdit = (memberKey: string) => {
    rememberOrigin();
    setAgentDialogState({ type: "edit", memberKey, nonce: ++agentDialogSeq.current });
  };
  const closePanel = () => setAgentDialogState(null);

  useEffect(() => {
    if (agentDialog !== null || !panelOrigin.current) return;
    const origin = panelOrigin.current;
    panelOrigin.current = null;
    const root = popupRef.current;
    if (!root) return;
    const buttons = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>("button")];
    const byLabel = (scope: ParentNode) =>
      buttons(scope).find(
        (button) =>
          (button.getAttribute("aria-label") ?? button.textContent?.trim()) === origin.label,
      );
    const card = origin.card
      ? root.querySelector<HTMLElement>(`[data-testid="${origin.card}"]`)
      : null;
    // Same button if it is still there (Edit, New agent…), else the card it lived in
    // (Customize turns into Edit once added), else the selected tab.
    const target =
      (card && (byLabel(card) ?? buttons(card)[0])) ??
      byLabel(root) ??
      root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    target?.focus({ preventScroll: false });
  }, [agentDialog]);

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
  const pipelineAdded = COLLAB_PIPELINE_IDS.every((id) =>
    members.some((member) => member.templateId === id),
  );

  async function submit(): Promise<void> {
    if (!canCreate) return;
    setBusy(true);
    setError(undefined);
    try {
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

  // Recomputed each render: cheap, and it closes over the latest members.
  const dialogTarget: AgentDialogDraftTarget | null = (() => {
    if (!agentDialog) return null;
    const commonTitle = name.trim() || newGroupDefaultName(t.locale);
    const footerNote = t("newGroup.countOf", { count: members.length, max: GROUP_MAX_MEMBERS });

    if (agentDialog.type === "edit") {
      const member = members.find((m) => m.key === agentDialog.memberKey);
      if (!member) return null;
      const otherMembers = members.filter((m) => m.key !== member.key);
      const otherNames = otherMembers.map((m) => m.name);
      const tmpl = member.templateId
        ? AGENT_TEMPLATES.find((item) => item.id === member.templateId)
        : undefined;
      const defaultName = tmpl ? nextFreeName(tmpl.name, otherNames) : undefined;
      const sourceAgent = member.copiedFromAgentId
        ? (agents ?? []).find((agent) => agent.id === member.copiedFromAgentId)
        : undefined;

      const memberInput = newGroupMemberInput(member);

      return {
        title: commonTitle,
        mode: "edit",
        defaultName,
        sourceAgent,
        footerNote,
        seed: member.key,
        initial: {
          ...memberInput,
          modelId: member.modelId,
        },
        takenNames: otherNames,
        roles: otherMembers.map((m) => m.role),
        takenAvatarShapes: otherMembers.flatMap((m) => (m.avatarShape ? [m.avatarShape] : [])),
        onAdd: (input) => {
          setMembers((current) =>
            assignNewGroupAvatarShapes(
              current.map((m) => (m.key === member.key ? editedMember(m, input) : m)),
            ),
          );
          closePanel();
        },
        onRemove: () => {
          remove(member.key);
          closePanel();
        },
      };
    }

    if (agentDialog.type === "customize") {
      const template = agentDialog.template;
      const defaultName = templateMember(template, members, "preview").name;
      return {
        title: commonTitle,
        mode: "add",
        defaultName,
        footerNote,
        seed: `new-group:${keySeq.current + 1}`,
        takenNames: members.map((m) => m.name),
        roles: members.map((m) => m.role),
        takenAvatarShapes: members.flatMap((m) => (m.avatarShape ? [m.avatarShape] : [])),
        initial: {
          templateId: template.id,
          name: defaultName,
          role: template.role,
          instructions: template.instructions,
          avatarFace: template.avatarFace,
          avatarColor: template.avatarColor,
        },
        onAdd: (input) => {
          add(
            dialogMember(
              input,
              members,
              nextKey(),
              agentAvatarForId(`new-group:${keySeq.current + 1}`),
            ),
            template.suggestedLead === true,
          );
          closePanel();
        },
      };
    }

    if (agentDialog.type === "custom") {
      return {
        title: commonTitle,
        mode: "add",
        footerNote,
        seed: `new-group:${keySeq.current + 1}`,
        takenNames: members.map((m) => m.name),
        roles: members.map((m) => m.role),
        takenAvatarShapes: members.flatMap((m) => (m.avatarShape ? [m.avatarShape] : [])),
        onAdd: (input) => {
          add(
            dialogMember(
              input,
              members,
              nextKey(),
              agentAvatarForId(`new-group:${keySeq.current + 1}`),
            ),
            false,
          );
          closePanel();
        },
      };
    }

    return null;
  })();

  const nonTemplateMembers = members.filter((member) => member.source !== "template");
  const customMembers = members.filter((member) => member.source === "custom");

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/50 transition-opacity duration-(--motion-duration-base) ease-standard motion-reduce:transition-reduced-fade",
            "data-ending-style:opacity-0 data-starting-style:opacity-0",
          )}
        />
        <Dialog.Popup
          className={cn(
            "-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 flex h-[min(620px,calc(100vh-2rem))] w-[min(780px,calc(100vw-2rem))] flex-col",
            "origin-center overflow-hidden popup-chrome outline-none",
            "transition-[transform,opacity,scale] duration-(--motion-duration-base) ease-standard motion-reduce:transition-reduced-fade",
            "data-ending-style:scale-[0.96] data-ending-style:opacity-0",
            "data-starting-style:scale-[0.96] data-starting-style:opacity-0",
          )}
          data-testid="new-group-modal"
          ref={popupRef}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {dialogTarget ? (
              <m.div
                animate={{ opacity: 1, x: 0 }}
                className="flex min-h-0 flex-1 flex-col"
                exit={{ opacity: 0, x: motionOffset(24, reduceMotion) }}
                initial={{ opacity: 0, x: motionOffset(24, reduceMotion) }}
                key={`panel-${agentDialog?.nonce ?? 0}`}
                transition={motionTransition(tween("base"), reduceMotion)}
              >
                <AgentDialog
                  defaultModelId={defaultModelId}
                  draft={dialogTarget}
                  models={allModels}
                  onGenerate={services.generateProfile}
                  onOpenChange={(next) => {
                    if (!next) closePanel();
                  }}
                  open
                  surface="plain"
                />
              </m.div>
            ) : (
              <m.form
                animate={{ opacity: 1, x: 0 }}
                className="flex min-h-0 flex-1 flex-col"
                exit={{ opacity: 0, x: motionOffset(-24, reduceMotion) }}
                initial={{ opacity: 0, x: motionOffset(-24, reduceMotion) }}
                key="list"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
                transition={motionTransition(tween("base"), reduceMotion)}
              >
                <div className="px-4 pt-3.5 pb-1">
                  <Dialog.Title className="font-medium text-fg text-sm">
                    {t("newGroup.title")}
                  </Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-2xs text-fg-muted">
                    {t("newGroup.description")}
                  </Dialog.Description>
                </div>

                <div className="grid grid-cols-2 gap-2 px-4 pt-2">
                  <label className="flex flex-col gap-1" htmlFor="new-group-folder">
                    <span className="text-2xs text-fg-subtle">{t("newGroup.folder")}</span>
                    <SelectControl
                      ariaLabel={t("newGroup.folder")}
                      className={cn("flex items-center justify-between gap-2", FIELD, "px-2")}
                      id="new-group-folder"
                      onValueChange={(folderId) => void chooseFolder(folderId)}
                      options={[
                        ...projects.map((project) => ({
                          label: project.displayName,
                          value: project.id,
                        })),
                        { label: t("newGroup.addFolder"), value: ADD_FOLDER },
                      ]}
                      placeholder={t("newGroup.chooseFolder")}
                      value={workspaceId || null}
                    />
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

                <div className="px-4 pt-3">
                  <div
                    className="flex h-8 w-full items-center gap-1 rounded-lg bg-chip p-0.5"
                    role="tablist"
                  >
                    {TABS.map((item) => {
                      const selected = tab === item.id;
                      return (
                        <button
                          aria-selected={selected}
                          className={cn(
                            "flex h-7 flex-1 items-center justify-center rounded-md px-3 text-xs font-medium transition-all",
                            selected
                              ? "bg-surface text-fg shadow-sm"
                              : "text-fg-subtle hover:text-fg",
                          )}
                          key={item.id}
                          onClick={() => setTab(item.id)}
                          role="tab"
                          type="button"
                        >
                          {t(item.label)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4" role="tabpanel">
                  {tab === "templates" ? (
                    <div className="space-y-3">
                      <button
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors",
                          pipelineAdded
                            ? "border-hairline bg-chip-faint"
                            : "border-hairline bg-surface/40 hover:border-hairline-strong hover:bg-hover",
                        )}
                        data-testid="collab-pipeline"
                        onClick={() => addCollabPipeline()}
                        type="button"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-fg text-xs">
                            {t("newGroup.collabPipeline")}
                          </div>
                          <div className="mt-0.5 text-2xs text-fg-subtle">
                            {t("newGroup.collabPipelineHint")}
                          </div>
                        </div>
                        {pipelineAdded ? (
                          <span className="shrink-0 rounded bg-chip px-1.5 py-0.5 font-medium text-2xs text-fg-subtle">
                            {t("newGroup.added")}
                          </span>
                        ) : null}
                      </button>

                      <ul className="flex flex-col gap-2">
                        {nonTemplateMembers.map((member) => {
                          const isLead = member.key === leadKey;
                          const needsModel = !member.modelId;
                          const sourceAgent = member.copiedFromAgentId
                            ? (agents ?? []).find((a) => a.id === member.copiedFromAgentId)
                            : undefined;
                          const copyGroup = sourceAgent?.groupId
                            ? groupNames.get(sourceAgent.groupId)
                            : undefined;
                          const desc =
                            member.source === "copy"
                              ? copyGroup
                                ? t("newGroup.copiedFrom", { group: copyGroup })
                                : t("newGroup.copiedFromUnknown")
                              : t("newGroup.customSource");

                          return (
                            <li
                              className="group flex flex-col gap-2 rounded-xl bg-chip-faint p-3 ring-1 ring-hairline ring-inset"
                              data-selected
                              data-testid={`member-card-${member.key}`}
                              key={member.key}
                            >
                              <div className="flex items-center gap-3">
                                <AgentAvatar
                                  color={member.avatarColor}
                                  face={member.avatarFace}
                                  seed={newGroupMemberSeed(member)}
                                  shape={
                                    member.avatarShape ?? agentAvatarForId(member.key).avatarShape
                                  }
                                  size={48}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="truncate font-medium text-fg text-xs">
                                      {member.name}
                                    </span>
                                    <span className="rounded bg-chip px-1.5 py-0.5 font-medium text-2xs text-fg-subtle">
                                      {t("newGroup.added")}
                                    </span>
                                    <LeadCrownButton
                                      isLead={isLead}
                                      member={member}
                                      onToggle={() => setLeadKey(isLead ? null : member.key)}
                                    />
                                    {needsModel ? (
                                      <span className="font-medium text-2xs text-danger">
                                        {t("newGroup.needsModel")}
                                      </span>
                                    ) : null}
                                  </div>
                                  {member.role && member.role !== member.name ? (
                                    <div className="text-2xs text-fg-subtle">{member.role}</div>
                                  ) : null}
                                  <p className="mt-0.5 text-2xs text-fg-muted">{desc}</p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                  <button
                                    aria-label={t("newGroup.editLabel", { name: member.name })}
                                    className="h-7 rounded-md px-2.5 font-medium text-fg-subtle text-xs transition-colors hover:bg-hover hover:text-fg"
                                    onClick={() => openEdit(member.key)}
                                    type="button"
                                  >
                                    {t("newGroup.edit")}
                                  </button>
                                  <button
                                    aria-label={t("common.remove", { name: member.name })}
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
                                    onClick={() => remove(member.key)}
                                    type="button"
                                  >
                                    <IconX size={14} />
                                  </button>
                                </div>
                              </div>
                            </li>
                          );
                        })}

                        {AGENT_TEMPLATES.map((template) => {
                          const templateMembers = membersFromCard(members, {
                            templateId: template.id,
                          });
                          const count = templateMembers.length;

                          if (count === 0) {
                            return (
                              <li
                                aria-label={template.name}
                                className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface/40 p-3 transition-colors hover:border-hairline-strong"
                                data-testid={`template-card-${template.id}`}
                                key={template.id}
                              >
                                <div className="flex items-center gap-3">
                                  <AgentAvatar
                                    color={template.avatarColor}
                                    face={template.avatarFace}
                                    seed={template.id}
                                    shape={agentAvatarForId(template.id).avatarShape}
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
                                          className="text-dialog-warning"
                                          size={12}
                                        />
                                      ) : null}
                                    </div>
                                    {template.role !== template.name ? (
                                      <div className="text-2xs text-fg-subtle">{template.role}</div>
                                    ) : null}
                                    <p className="mt-0.5 text-2xs text-fg-muted">
                                      {template.description}
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1">
                                    <button
                                      aria-label={t("newGroup.customizeLabel", {
                                        name: template.name,
                                      })}
                                      className="h-7 rounded-md px-2.5 font-medium text-fg-subtle text-xs transition-colors hover:bg-hover hover:text-fg"
                                      onClick={() => openCustomize(template)}
                                      type="button"
                                    >
                                      {t("newGroup.customize")}
                                    </button>
                                    <button
                                      aria-label={t("newGroup.addLabel", { name: template.name })}
                                      className="flex h-7 items-center gap-1 rounded-md bg-chip px-2.5 font-medium text-fg text-xs transition-colors hover:bg-chip-strong"
                                      onClick={() => addTemplate(template)}
                                      type="button"
                                    >
                                      <IconPlus size={12} />
                                      {t("newGroup.add")}
                                    </button>
                                  </div>
                                </div>
                              </li>
                            );
                          }

                          const member = templateMembers[0];
                          if (count === 1 && member) {
                            const isLead = member.key === leadKey;
                            return (
                              <li
                                aria-label={template.name}
                                className="group flex flex-col gap-2 rounded-xl bg-chip-faint p-3 ring-1 ring-hairline ring-inset"
                                data-selected
                                data-testid={`template-card-${template.id}`}
                                key={template.id}
                              >
                                <div className="flex items-center gap-3">
                                  <AgentAvatar
                                    color={member.avatarColor}
                                    face={member.avatarFace}
                                    seed={newGroupMemberSeed(member)}
                                    shape={
                                      member.avatarShape ??
                                      agentAvatarForId(template.id).avatarShape
                                    }
                                    size={48}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="truncate font-medium text-fg text-xs">
                                        {member.name}
                                      </span>
                                      <span className="rounded bg-chip px-1.5 py-0.5 font-medium text-2xs text-fg-subtle">
                                        {t("newGroup.added")}
                                      </span>
                                      <LeadCrownButton
                                        isLead={isLead}
                                        member={member}
                                        onToggle={() => setLeadKey(isLead ? null : member.key)}
                                      />
                                    </div>
                                    {member.role && member.role !== member.name ? (
                                      <div className="text-2xs text-fg-subtle">{member.role}</div>
                                    ) : null}
                                    <p className="mt-0.5 text-2xs text-fg-muted">
                                      {template.description}
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1">
                                    <button
                                      aria-label={t("newGroup.editLabel", { name: member.name })}
                                      className="h-7 rounded-md px-2.5 font-medium text-fg-subtle text-xs transition-colors hover:bg-hover hover:text-fg"
                                      onClick={() => openEdit(member.key)}
                                      type="button"
                                    >
                                      {t("newGroup.edit")}
                                    </button>
                                    <button
                                      aria-label={t("common.remove", { name: member.name })}
                                      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
                                      onClick={() => remove(member.key)}
                                      type="button"
                                    >
                                      <IconX size={14} />
                                    </button>
                                    <button
                                      aria-label={t("newGroup.addLabel", { name: template.name })}
                                      className="flex h-7 items-center gap-1 rounded-md bg-chip px-2.5 font-medium text-fg text-xs transition-colors hover:bg-chip-strong"
                                      onClick={() => addTemplate(template)}
                                      type="button"
                                    >
                                      <IconPlus size={12} />
                                      {t("newGroup.addAnother")}
                                    </button>
                                  </div>
                                </div>
                              </li>
                            );
                          }

                          return (
                            <li
                              aria-label={template.name}
                              className="flex flex-col gap-2 rounded-xl bg-chip-faint p-3 ring-1 ring-hairline ring-inset"
                              data-selected
                              data-testid={`template-card-${template.id}`}
                              key={template.id}
                            >
                              <div className="flex items-center gap-3">
                                <AgentAvatar
                                  color={template.avatarColor}
                                  face={template.avatarFace}
                                  seed={template.id}
                                  shape={agentAvatarForId(template.id).avatarShape}
                                  size={48}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="truncate font-medium text-fg text-xs">
                                      {template.name}
                                    </span>
                                    <span className="rounded bg-chip px-1.5 py-0.5 font-medium text-2xs text-fg-subtle">
                                      {t("newGroup.addedCount", { count })}
                                    </span>
                                  </div>
                                  {template.role !== template.name ? (
                                    <div className="text-2xs text-fg-subtle">{template.role}</div>
                                  ) : null}
                                  <p className="mt-0.5 text-2xs text-fg-muted">
                                    {template.description}
                                  </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                  <button
                                    aria-label={t("newGroup.addLabel", { name: template.name })}
                                    className="flex h-7 items-center gap-1 rounded-md bg-chip px-2.5 font-medium text-fg text-xs transition-colors hover:bg-chip-strong"
                                    onClick={() => addTemplate(template)}
                                    type="button"
                                  >
                                    <IconPlus size={12} />
                                    {t("newGroup.addAnother")}
                                  </button>
                                </div>
                              </div>
                              <div className="flex flex-col divide-y divide-hairline-soft border-hairline-soft border-t pt-1">
                                {templateMembers.map((member) => {
                                  const isLead = member.key === leadKey;
                                  return (
                                    <div
                                      className="group/line flex items-center gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-hover/50"
                                      key={member.key}
                                    >
                                      <AgentAvatar
                                        color={member.avatarColor}
                                        face={member.avatarFace}
                                        seed={newGroupMemberSeed(member)}
                                        shape={
                                          member.avatarShape ??
                                          agentAvatarForId(template.id).avatarShape
                                        }
                                        size={24}
                                      />
                                      <span className="min-w-0 truncate font-medium text-fg text-xs">
                                        {member.name}
                                      </span>
                                      <LeadCrownButton
                                        groupVariant="line"
                                        isLead={isLead}
                                        member={member}
                                        onToggle={() => setLeadKey(isLead ? null : member.key)}
                                      />
                                      <div className="ml-auto flex shrink-0 items-center gap-1">
                                        <button
                                          aria-label={t("newGroup.editLabel", {
                                            name: member.name,
                                          })}
                                          className="h-7 rounded-md px-2 font-medium text-fg-subtle text-xs transition-colors hover:bg-hover hover:text-fg"
                                          onClick={() => openEdit(member.key)}
                                          type="button"
                                        >
                                          {t("newGroup.edit")}
                                        </button>
                                        <button
                                          aria-label={t("common.remove", { name: member.name })}
                                          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
                                          onClick={() => remove(member.key)}
                                          type="button"
                                        >
                                          <IconX size={14} />
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : tab === "copy" ? (
                    <div className="flex flex-col gap-2">
                      <p className="mb-1 text-2xs text-fg-muted">{t("newGroup.copyHint")}</p>
                      {agents === null ? (
                        <p className="text-fg-muted text-xs">{t("newGroup.loadingAgents")}</p>
                      ) : agentsError ? (
                        <p className="text-danger text-xs" role="alert">
                          {agentsError}
                        </p>
                      ) : copyable.length === 0 ? (
                        <p className="text-fg-muted text-xs">{t("newGroup.noCopyable")}</p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {copyable.map((agent) => {
                            const groupName = groupNames.get(agent.groupId ?? "") ?? "";
                            const copies = membersFromCard(members, {
                              copiedFromAgentId: agent.id,
                            });
                            const single = copies[0];
                            const count = copies.length;

                            return (
                              <li
                                data-testid={`copy-card-${agent.id}`}
                                className={cn(
                                  "flex flex-col gap-2 rounded-xl p-3 transition-colors",
                                  count > 0
                                    ? "group bg-chip-faint ring-1 ring-hairline ring-inset"
                                    : "border border-hairline bg-surface/40 hover:border-hairline-strong",
                                )}
                                key={agent.id}
                              >
                                <div className="flex items-center gap-3">
                                  <AgentAvatar
                                    color={agent.avatarColor}
                                    face={agent.avatarFace}
                                    seed={agentAvatarSeed(agent)}
                                    shape={agent.avatarShape}
                                    size={48}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="truncate font-medium text-fg text-xs">
                                        {agent.name}
                                      </span>
                                      {count === 1 && single ? (
                                        <>
                                          <span className="rounded bg-chip px-1.5 py-0.5 font-medium text-2xs text-fg-subtle">
                                            {t("newGroup.added")}
                                          </span>
                                          <LeadCrownButton
                                            isLead={single.key === leadKey}
                                            member={single}
                                            onToggle={() =>
                                              setLeadKey(single.key === leadKey ? null : single.key)
                                            }
                                          />
                                          {!single.modelId ? (
                                            <span className="font-medium text-2xs text-danger">
                                              {t("newGroup.needsModel")}
                                            </span>
                                          ) : null}
                                        </>
                                      ) : count >= 2 ? (
                                        <span className="rounded bg-chip px-1.5 py-0.5 font-medium text-2xs text-fg-subtle">
                                          {t("newGroup.addedCount", { count })}
                                        </span>
                                      ) : null}
                                    </div>
                                    <div className="flex items-center gap-1 text-2xs text-fg-subtle">
                                      {agent.role ? <span>{agent.role} · </span> : null}
                                      <span>{groupName}</span>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1">
                                    {count === 1 && single ? (
                                      <>
                                        <button
                                          aria-label={t("newGroup.editLabel", {
                                            name: single.name,
                                          })}
                                          className="h-7 rounded-md px-2.5 font-medium text-fg-subtle text-xs transition-colors hover:bg-hover hover:text-fg"
                                          onClick={() => openEdit(single.key)}
                                          type="button"
                                        >
                                          {t("newGroup.edit")}
                                        </button>
                                        <button
                                          aria-label={t("common.remove", {
                                            name: single.name,
                                          })}
                                          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
                                          onClick={() => remove(single.key)}
                                          type="button"
                                        >
                                          <IconX size={14} />
                                        </button>
                                      </>
                                    ) : null}
                                    <button
                                      aria-label={t("newGroup.copyLabel", {
                                        name: agent.name,
                                        group: groupName,
                                      })}
                                      className="flex h-7 items-center gap-1 rounded-md bg-chip px-2.5 font-medium text-fg text-xs transition-colors hover:bg-chip-strong"
                                      onClick={() =>
                                        add(
                                          copyMember(agent, members, nextKey(), fallbackModelId),
                                          false,
                                        )
                                      }
                                      type="button"
                                    >
                                      {t("newGroup.copy")}
                                    </button>
                                  </div>
                                </div>
                                {count >= 2 ? (
                                  <div className="flex flex-col divide-y divide-hairline-soft border-hairline-soft border-t pt-1">
                                    {copies.map((member) => {
                                      const isLead = member.key === leadKey;
                                      const needsModel = !member.modelId;
                                      return (
                                        <div
                                          className="group/line flex items-center gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-hover/50"
                                          key={member.key}
                                        >
                                          <AgentAvatar
                                            color={member.avatarColor}
                                            face={member.avatarFace}
                                            seed={newGroupMemberSeed(member)}
                                            {...(member.avatarShape
                                              ? { shape: member.avatarShape }
                                              : {})}
                                            size={24}
                                          />
                                          <span className="min-w-0 truncate font-medium text-fg text-xs">
                                            {member.name}
                                          </span>
                                          <LeadCrownButton
                                            groupVariant="line"
                                            isLead={isLead}
                                            member={member}
                                            onToggle={() => setLeadKey(isLead ? null : member.key)}
                                          />
                                          {needsModel ? (
                                            <span className="font-medium text-2xs text-danger">
                                              {t("newGroup.needsModel")}
                                            </span>
                                          ) : null}
                                          <div className="ml-auto flex shrink-0 items-center gap-1">
                                            <button
                                              aria-label={t("newGroup.editLabel", {
                                                name: member.name,
                                              })}
                                              className="h-7 rounded-md px-2 font-medium text-fg-subtle text-xs transition-colors hover:bg-hover hover:text-fg"
                                              onClick={() => openEdit(member.key)}
                                              type="button"
                                            >
                                              {t("newGroup.edit")}
                                            </button>
                                            <button
                                              aria-label={t("common.remove", {
                                                name: member.name,
                                              })}
                                              className="flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
                                              onClick={() => remove(member.key)}
                                              type="button"
                                            >
                                              <IconX size={14} />
                                            </button>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-col items-start gap-2 text-fg-subtle text-xs">
                        <p>{t("newGroup.customHint")}</p>
                        <button
                          className="flex h-7 items-center gap-1 rounded-md bg-accent px-3 font-medium text-white text-xs transition-opacity hover:opacity-90"
                          onClick={() => openCustom()}
                          type="button"
                        >
                          <IconPlus size={12} />
                          {t("newGroup.newAgent")}
                        </button>
                      </div>
                      {customMembers.length > 0 ? (
                        <ul className="flex flex-col gap-2">
                          {customMembers.map((member) => {
                            const isLead = member.key === leadKey;
                            const needsModel = !member.modelId;
                            return (
                              <li
                                className="group flex flex-col gap-2 rounded-xl bg-chip-faint p-3 ring-1 ring-hairline ring-inset"
                                data-selected
                                data-testid={`member-card-${member.key}`}
                                key={member.key}
                              >
                                <div className="flex items-center gap-3">
                                  <AgentAvatar
                                    color={member.avatarColor}
                                    face={member.avatarFace}
                                    seed={newGroupMemberSeed(member)}
                                    shape={
                                      member.avatarShape ?? agentAvatarForId(member.key).avatarShape
                                    }
                                    size={48}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="truncate font-medium text-fg text-xs">
                                        {member.name}
                                      </span>
                                      <span className="rounded bg-chip px-1.5 py-0.5 font-medium text-2xs text-fg-subtle">
                                        {t("newGroup.added")}
                                      </span>
                                      <LeadCrownButton
                                        isLead={isLead}
                                        member={member}
                                        onToggle={() => setLeadKey(isLead ? null : member.key)}
                                      />
                                      {needsModel ? (
                                        <span className="font-medium text-2xs text-danger">
                                          {t("newGroup.needsModel")}
                                        </span>
                                      ) : null}
                                    </div>
                                    {member.role && member.role !== member.name ? (
                                      <div className="text-2xs text-fg-subtle">{member.role}</div>
                                    ) : null}
                                    <p className="mt-0.5 text-2xs text-fg-muted">
                                      {t("newGroup.customSource")}
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1">
                                    <button
                                      aria-label={t("newGroup.editLabel", {
                                        name: member.name,
                                      })}
                                      className="h-7 rounded-md px-2.5 font-medium text-fg-subtle text-xs transition-colors hover:bg-hover hover:text-fg"
                                      onClick={() => openEdit(member.key)}
                                      type="button"
                                    >
                                      {t("newGroup.edit")}
                                    </button>
                                    <button
                                      aria-label={t("common.remove", { name: member.name })}
                                      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
                                      onClick={() => remove(member.key)}
                                      type="button"
                                    >
                                      <IconX size={14} />
                                    </button>
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </div>
                  )}
                </div>

                {error ? (
                  <div
                    className="mx-4 mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/8 px-2.5 py-2 text-danger text-xs"
                    role="alert"
                  >
                    {error}
                  </div>
                ) : null}

                <div className="flex items-center gap-2 border-hairline-soft border-t px-4 py-2.5">
                  <span
                    className="min-w-0 flex-1 truncate text-2xs text-fg-muted"
                    data-testid="new-group-hint"
                  >
                    {blocker ?? ""}
                  </span>
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      overLimit ? "text-danger" : "text-fg-subtle",
                    )}
                    data-testid="new-group-counter"
                  >
                    {newGroupCounter(members.length, t.locale)}
                  </span>
                  <button
                    className="h-7 rounded-md px-3 text-fg-muted text-xs transition-colors hover:bg-hover hover:text-fg"
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
              </m.form>
            )}
          </AnimatePresence>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
