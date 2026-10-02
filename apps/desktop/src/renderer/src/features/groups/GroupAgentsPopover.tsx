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
import { AgentAvatar } from "../agents/AgentAvatar";
import { AgentDialog } from "../agents/AgentDialog";
import { agentAvatarState, memberAvatar } from "../agents/agentAvatarModel";
import type { GroupDialogModel } from "./CreateGroupDialog";
import type { WorkingMemberAvatar } from "./GroupWorkingStatus";
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
        title={agent.name}
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
  memberStates,
  models = [],
  defaultModelId,
  onAgentsChanged,
}: {
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  group: AgentGroupWithMembers;
  memberStates: GroupMemberStatesById;
  models?: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  onAgentsChanged?(): void;
}) {
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
        aria-label="Agent presence"
        className="m-0 flex shrink-0 items-center border-0 p-0 -space-x-2"
        data-testid="group-agent-presence"
      >
        {group.members.map((member) => {
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
              triggerClassName="relative z-0 flex size-8 shrink-0 aspect-square items-center justify-center rounded-full outline-none transition-transform hover:z-10 hover:scale-105 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          ) : (
            <button
              aria-label={`${label} profile unavailable`}
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
      </fieldset>
    </div>
  );
}
