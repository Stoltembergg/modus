import { Popover } from "@base-ui/react/popover";
import { IconCrown, IconDots, IconMessage } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AgentGroupWithMembers,
  AgentInfo,
  UpdateAgentInput,
} from "../../../../shared/contracts";
import {
  MorphingDialog,
  MorphingDialogClose,
  MorphingDialogContainer,
  MorphingDialogContent,
  MorphingDialogTitle,
  MorphingDialogTrigger,
} from "../../components/ui/MorphingDialog";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { AgentAvatar } from "../agents/AgentAvatar";
import { AgentDialog } from "../agents/AgentDialog";
import { agentAvatarState, memberAvatar } from "../agents/agentAvatarModel";
import type { GroupDialogModel } from "./CreateGroupDialog";
import type { WorkingMemberAvatar } from "./GroupWorkingStatus";
import type { MentionMember } from "./groupMentions";
import { MemberName } from "./MemberName";
import { type MemberLabel, memberLabels, memberLabelText } from "./memberLabels";
import { type GroupMemberStatesById, memberActivityState } from "./useWorkingGroups";

function AgentMorphEdit({
  agent,
  group,
  models,
  defaultModelId,
  onUpdated,
  trigger,
  triggerClassName = "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-hover",
}: {
  agent: AgentInfo;
  group: AgentGroupWithMembers;
  models: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  onUpdated(): void;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <MorphingDialog onOpenChange={setOpen} open={open}>
      <MorphingDialogTrigger
        aria-label={`Edit ${agent.name}`}
        className={triggerClassName}
        data-testid="group-agent-avatar-trigger"
      >
        {trigger}
      </MorphingDialogTrigger>
      <MorphingDialogContainer>
        <MorphingDialogContent className="relative w-[min(480px,calc(100vw-2rem))] popup-chrome">
          <MorphingDialogClose />
          <MorphingDialogTitle className="sr-only">Edit {agent.name}</MorphingDialogTitle>
          <div className="max-h-[80vh] overflow-y-auto" data-testid="morphing-agent-edit">
            <AgentDialog
              agent={agent}
              defaultModelId={defaultModelId}
              group={group}
              models={models}
              onCreate={async () => undefined}
              onGenerate={(input) => window.modus.agents.generateProfile(input)}
              onOpenChange={(next) => {
                setOpen(next);
              }}
              onUpdate={async (input: UpdateAgentInput & { id: string }) => {
                await window.modus.agents.update(input);
                onUpdated();
              }}
              open={open}
              surface="plain"
            />
          </div>
        </MorphingDialogContent>
      </MorphingDialogContainer>
    </MorphingDialog>
  );
}

export function GroupAgentsPopover({
  avatars,
  group,
  members,
  memberStates,
  models = [],
  defaultModelId,
  onOpenAgentChat,
  onManageMembers,
  onSetLead,
  onAgentsChanged,
}: {
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  group: AgentGroupWithMembers;
  members: readonly MentionMember[];
  memberStates: GroupMemberStatesById;
  models?: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  onOpenAgentChat(agentId: string): void;
  onManageMembers(): void;
  onSetLead?(sessionId: string | null): void;
  onAgentsChanged?(): void;
}) {
  const labels = useMemo(() => memberLabels(members), [members]);
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.modus.agents
      .list()
      .then((list: AgentInfo[]) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const visibleMembers = group.members.slice(0, 4);

  return (
    <div className="flex items-center gap-1">
      <fieldset
        aria-label="Agent presence"
        className="m-0 flex min-w-0 items-center border-0 p-0 -space-x-2"
        data-testid="group-agent-presence"
      >
        {visibleMembers.map((member) => {
          const avatar = avatars.get(member.sessionId) ?? {
            agentId: member.agentId,
            ...memberAvatar(member),
            archived: member.archived === true,
          };
          const state = memberActivityState(memberStates, group.id, member.sessionId);
          const label = member.name;
          const agent = agentsById.get(member.agentId);
          const face = (
            <span
              className="relative flex size-7 items-center justify-center rounded-full ring-2 ring-[var(--surface-main)]"
              key={member.sessionId}
            >
              <AgentAvatar
                className="scale-125"
                color={avatar.color}
                face={avatar.face}
                seed={avatar.agentId}
                shape={avatar.shape}
                size={20}
                state={agentAvatarState(state, avatar.archived)}
              />
              <span
                aria-hidden
                className={cn(
                  "absolute right-0 bottom-0 size-2 rounded-full border border-[var(--surface-main)] transition-colors duration-[var(--motion-ui)]",
                  state === "working"
                    ? "bg-success"
                    : state === "waiting"
                      ? "bg-amber-400"
                      : "bg-fg-faint",
                )}
                data-presence={state}
                title={state === "working" ? "Working" : state === "waiting" ? "Waiting" : "Idle"}
              />
            </span>
          );
          return agent ? (
            <AgentMorphEdit
              agent={agent}
              defaultModelId={defaultModelId}
              group={group}
              key={member.sessionId}
              models={models}
              onUpdated={() => {
                void window.modus.agents
                  .list()
                  .then(setAgents)
                  .catch(() => undefined);
                onAgentsChanged?.();
              }}
              trigger={face}
              triggerClassName="relative z-0 flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition-transform hover:z-10 hover:scale-105 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          ) : (
            <button
              aria-label={`${label} profile unavailable`}
              className="relative z-0 flex size-7 shrink-0 items-center justify-center rounded-full ring-2 ring-[var(--surface-main)]"
              disabled
              key={member.sessionId}
              title={`${label} profile unavailable`}
              type="button"
            >
              {face}
            </button>
          );
        })}
        {group.members.length > visibleMembers.length ? (
          <span className="flex size-7 items-center justify-center rounded-full bg-elevated text-2xs text-fg-muted ring-2 ring-[var(--surface-main)]">
            +{group.members.length - visibleMembers.length}
          </span>
        ) : null}
      </fieldset>
      <Popover.Root onOpenChange={setOpen} open={open}>
        <Popover.Trigger
          aria-label="Agent actions"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg data-popup-open:bg-hover"
          data-testid="group-agent-actions-button"
          title="Agent actions"
        >
          <IconDots size={ICON.sm} stroke={ICON_STROKE.sm} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner align="end" side="bottom" sideOffset={6}>
            <Popover.Popup
              className="origin-(--transform-origin) w-[min(320px,calc(100vw-24px))] popup-chrome popup-motion p-1.5"
              data-testid="group-agents-popover"
            >
              <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1.5">
                <p className="text-2xs text-fg-faint">Members</p>
                <button
                  className="rounded px-1.5 py-0.5 text-2xs text-fg-muted hover:bg-hover hover:text-fg"
                  onClick={() => {
                    setOpen(false);
                    onManageMembers();
                  }}
                  type="button"
                >
                  Manage
                </button>
              </div>
              <ul className="flex max-h-[360px] flex-col gap-0.5 overflow-y-auto">
                {group.members.map((member) => {
                  const avatar = avatars.get(member.sessionId) ?? {
                    agentId: member.agentId,
                    ...memberAvatar(member),
                    archived: member.archived === true,
                  };
                  const state = memberActivityState(memberStates, group.id, member.sessionId);
                  const label: MemberLabel = labels.get(member.sessionId) ?? { title: member.name };
                  const isLead = group.leadSessionId === member.sessionId;
                  const agent = agentsById.get(member.agentId);
                  const row = (
                    <>
                      <AgentAvatar
                        color={avatar.color}
                        face={avatar.face}
                        seed={avatar.agentId}
                        shape={avatar.shape}
                        size={20}
                        state={agentAvatarState(state, avatar.archived)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1">
                          <span className="truncate text-fg text-xs">
                            <MemberName label={label} />
                          </span>
                          {state !== "idle" ? (
                            <span
                              className={cn(
                                "shrink-0 text-2xs",
                                state === "working" ? "text-success" : "text-amber-400",
                              )}
                            >
                              {state === "working" ? "Working" : "Waiting"}
                            </span>
                          ) : null}
                          {isLead ? (
                            <span className="flex shrink-0 items-center gap-0.5 text-2xs text-accent">
                              <IconCrown aria-hidden size={ICON.xs} stroke={ICON_STROKE.xs} />
                              Lead
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate text-2xs text-fg-faint">
                          {member.role?.trim() || member.agentRole.trim() || "Member"}
                          {member.archived ? " · archived" : ""}
                        </span>
                      </span>
                    </>
                  );
                  return (
                    <li
                      className="flex items-stretch gap-0.5"
                      data-testid="group-agents-member"
                      key={member.sessionId}
                    >
                      <div className="min-w-0 flex-1">
                        {agent ? (
                          <AgentMorphEdit
                            agent={agent}
                            defaultModelId={defaultModelId}
                            group={group}
                            models={models}
                            onUpdated={() => {
                              void window.modus.agents.list().then(setAgents);
                              onAgentsChanged?.();
                            }}
                            trigger={row}
                          />
                        ) : (
                          <div className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5">
                            {row}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5 pr-0.5">
                        <button
                          aria-label={`Open chat with ${memberLabelText(label)}`}
                          className="flex size-7 items-center justify-center rounded-md text-fg-faint hover:bg-hover hover:text-fg"
                          data-testid="group-agent-open-chat"
                          onClick={() => {
                            setOpen(false);
                            onOpenAgentChat(member.agentId);
                          }}
                          title={`Chat with ${memberLabelText(label)}`}
                          type="button"
                        >
                          <IconMessage size={ICON.xs} stroke={ICON_STROKE.xs} />
                        </button>
                        {onSetLead ? (
                          <button
                            aria-label={
                              isLead ? "Clear lead" : `Make ${memberLabelText(label)} lead`
                            }
                            className={cn(
                              "flex size-7 items-center justify-center rounded-md hover:bg-hover",
                              isLead ? "text-accent" : "text-fg-faint hover:text-fg",
                            )}
                            data-testid="group-agent-toggle-lead"
                            onClick={() => onSetLead(isLead ? null : member.sessionId)}
                            type="button"
                          >
                            <IconCrown size={ICON.xs} stroke={ICON_STROKE.xs} />
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
