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
import { AgentAvatar } from "../agents/AgentAvatar";
import { AgentDialog } from "../agents/AgentDialog";
import {
  AGENT_PRESENCE_LABEL,
  AgentPresenceDot,
  type AgentPresenceState,
} from "../agents/AgentPresenceDot";
import { agentAvatarState, memberAvatar } from "../agents/agentAvatarModel";
import type { GroupDialogModel } from "./CreateGroupDialog";
import type { WorkingMemberAvatar } from "./GroupWorkingStatus";
import { useGroupText } from "./groupRoomI18n";
import { type GroupMemberStatesById, memberActivityState } from "./useWorkingGroups";

function AgentMorphEdit({
  agent,
  group,
  models,
  defaultModelId,
  onUpdated,
  trigger,
  triggerLabel,
  triggerDescription,
  triggerTitle,
  triggerClassName = "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-hover",
}: {
  agent: AgentInfo;
  group: AgentGroupWithMembers;
  models: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  onUpdated(): void;
  trigger: React.ReactNode;
  triggerLabel?: string;
  triggerDescription?: string;
  triggerTitle?: string;
  triggerClassName?: string;
}) {
  const t = useGroupText();
  const [open, setOpen] = useState(false);
  return (
    <MorphingDialog onOpenChange={setOpen} open={open}>
      <MorphingDialogTrigger
        aria-label={triggerLabel ?? t("popover.edit", { name: agent.name })}
        aria-description={triggerDescription}
        className={triggerClassName}
        data-testid="group-agent-avatar-trigger"
        title={triggerTitle ?? agent.name}
      >
        {trigger}
      </MorphingDialogTrigger>
      <MorphingDialogContainer>
        <MorphingDialogContent className="relative w-[min(480px,calc(100vw-2rem))] popup-chrome">
          <MorphingDialogClose />
          <MorphingDialogTitle className="sr-only">
            {t("popover.edit", { name: agent.name })}
          </MorphingDialogTitle>
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
  memberStates,
  models = [],
  defaultModelId,
  onAgentsChanged,
  maxVisible,
}: {
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  group: AgentGroupWithMembers;
  memberStates: GroupMemberStatesById;
  models?: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  onAgentsChanged?(): void;
  /** L3c: narrow headers show this many avatars, then a "+N" chip (names in its tooltip). */
  maxVisible?: number | undefined;
}) {
  const t = useGroupText();
  const visible =
    maxVisible !== undefined && group.members.length > maxVisible
      ? group.members.slice(0, Math.max(1, maxVisible - 1))
      : group.members;
  const hidden = group.members.slice(visible.length);
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

  return (
    <div className="flex w-fit shrink-0 items-center">
      <fieldset
        aria-label={t("popover.agentPresence")}
        className="m-0 flex shrink-0 items-center border-0 p-0 -space-x-2"
        data-testid="group-agent-presence"
      >
        {visible.map((member) => {
          const avatar = avatars.get(member.sessionId) ?? {
            agentId: member.agentId,
            ...memberAvatar(member),
            archived: member.archived === true,
          };
          const state = memberActivityState(memberStates, group.id, member.sessionId);
          const presence: AgentPresenceState = avatar.archived ? "archived" : state;
          const label = member.name;
          const agent = agentsById.get(member.agentId);
          const face = (
            <span
              className="relative flex size-8 shrink-0 aspect-square items-center justify-center rounded-full"
              key={member.sessionId}
            >
              <AgentAvatar
                color={avatar.color}
                face={avatar.face}
                seed={avatar.agentId}
                shape={avatar.shape}
                size={24}
                state={agentAvatarState(state, avatar.archived)}
              />
              <AgentPresenceDot
                className="absolute right-0 bottom-0 transition-colors duration-[var(--motion-ui)]"
                state={presence}
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
              triggerDescription={AGENT_PRESENCE_LABEL[presence]}
              triggerTitle={label}
              triggerClassName="relative z-0 flex size-8 shrink-0 aspect-square items-center justify-center rounded-full outline-none transition-transform hover:z-10 hover:scale-105 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          ) : (
            <button
              aria-label={t("popover.profileUnavailable", {
                name: label,
                presence: AGENT_PRESENCE_LABEL[presence],
              })}
              className="relative z-0 flex size-8 shrink-0 aspect-square items-center justify-center rounded-full"
              disabled
              key={member.sessionId}
              title={label}
              type="button"
            >
              {face}
            </button>
          );
        })}
        {hidden.length > 0 ? (
          <span
            aria-label={t("header.moreAgents", {
              count: hidden.length,
              names: hidden.map((member) => member.name).join(", "),
            })}
            className="relative z-0 flex size-8 shrink-0 items-center justify-center"
            data-testid="group-agent-overflow"
            role="img"
            title={hidden.map((member) => member.name).join(", ")}
          >
            <span className="flex size-6 items-center justify-center rounded-full border border-hairline bg-chip text-2xs text-fg-muted tabular-nums">
              +{hidden.length}
            </span>
          </span>
        ) : null}
      </fieldset>
    </div>
  );
}
