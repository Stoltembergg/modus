import { Dialog } from "@base-ui/react/dialog";
import { IconRefresh } from "@tabler/icons-react";
import { useId, useMemo, useRef, useState } from "react";
import { agentAvatarForId, getAgentTemplate } from "../../../../shared/agent-templates";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  AGENT_AVATAR_SHAPES,
  type AgentAvatarColor,
  type AgentAvatarFace,
  type AgentAvatarShape,
  type AgentGroupWithMembers,
  type AgentInfo,
  type CreateGroupAgentInput,
  type GenerateAgentProfileInput,
  type GeneratedAgentProfile,
  type NewGroupAgentInput,
  type UpdateAgentInput,
} from "../../../../shared/contracts";
import {
  GROUP_CAPABILITY_IDS,
  GROUP_SUPPORTED_TASK_KINDS,
  normalizeGroupMemberCapabilities,
} from "../../../../shared/group-capabilities";
import { cn } from "../../lib/cn";
import { ModelOptions, pickModel } from "../../lib/modusModels";
import type { GroupDialogModel } from "../groups/CreateGroupDialog";
import { describeGroupError } from "../groups/groupErrors";
import { AgentAvatar } from "./AgentAvatar";
import { AGENT_AVATAR_FILL } from "./agentAvatarModel";
import { agentDialogError, needsProfileGeneration } from "./agentDialogModel";

export const AGENT_GENERATED_HINT = "Generated. Review the role and instructions, then save.";

const FIELD = cn(
  "h-8 w-full rounded-lg border border-hairline bg-canvas px-2.5 text-sm text-fg outline-none",
  "transition-colors placeholder:text-fg-faint focus:border-hairline-strong",
);

/**
 * The create-group modal (A4): the agent is not created here but added to the
 * modal's member list (the group and its agents are created in ONE
 * `group:create`). No group exists yet, so names are checked against the
 * modal's members and generation gets their roles.
 */
export type AgentDialogDraftTarget = {
  /** Subtitle (the group being created). */
  title: string;
  /** Names already in the modal (unique per group, case-insensitive). */
  takenNames: readonly string[];
  /** Roles already chosen in the modal (generation complements them). */
  roles: readonly string[];
  /** Shapes already assigned to draft members. */
  takenAvatarShapes?: readonly AgentAvatarShape[];
  /** Avatar seed for a fresh custom agent. */
  seed: string;
  /** Prefill ("Customize" on a template card carries its `templateId`). */
  initial?: NewGroupAgentInput | undefined;
  onAdd(member: NewGroupAgentInput): void;
};

type AgentDialogCommonProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  models: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  /** `agents:generate-profile`: resolves the Generalist fallback on a model failure. */
  onGenerate(input: GenerateAgentProfileInput): Promise<GeneratedAgentProfile>;
  /**
   * `dialog` (default): Base UI modal. `plain`: form only, for Morphing Dialog
   * hosts that already provide chrome and focus trap.
   */
  surface?: "dialog" | "plain";
};

type AgentDialogGroupProps = {
  /** The agent's group: its other members' names must differ (roles feed generation). */
  group: AgentGroupWithMembers;
  /** Edit this agent; without it the dialog creates a custom agent in `group`. */
  agent?: AgentInfo | undefined;
  onCreate(input: CreateGroupAgentInput): Promise<void>;
  onUpdate(input: UpdateAgentInput & { id: string }): Promise<void>;
  draft?: undefined;
};

type AgentDialogDraftProps = {
  draft: AgentDialogDraftTarget;
  group?: undefined;
  agent?: undefined;
  onCreate?: undefined;
  onUpdate?: undefined;
};

export type AgentDialogProps = AgentDialogCommonProps &
  (AgentDialogGroupProps | AgentDialogDraftProps);

/**
 * Create / edit an agent (A3): name, role, instructions, model, face and color
 * with an animated 48 px preview. A custom agent (no template) needs a name and
 * a model. Creating one with an empty role AND empty instructions first asks
 * the model for them (shown here, editable; the button reads "Generate", then "Create" saves); "Regenerate"
 * asks again. The profile is saved once, never regenerated per wake. Render
 * it only while open: each open starts from a fresh draft.
 */
export function AgentDialog(props: AgentDialogProps) {
  const {
    open,
    onOpenChange,
    group,
    agent,
    models,
    defaultModelId,
    onGenerate,
    draft: target,
  } = props;
  const initial = target?.initial;
  const custom = !(agent?.templateId ?? initial?.templateId);
  // Mounted per open (the parent renders it only while open): state starts from the agent.
  const surface = props.surface ?? "dialog";
  const occupiedShapes = useMemo(() => {
    const shapes =
      target?.takenAvatarShapes ??
      (group?.members ?? [])
        .filter((member) => member.agentId !== agent?.id)
        .flatMap((member) => (member.avatarShape ? [member.avatarShape] : []));
    return new Set(shapes);
  }, [target?.takenAvatarShapes, group?.members, agent?.id]);
  const [initialAvatar] = useState(() => {
    const seededAvatar = agentAvatarForId(
      target ? target.seed : `${group?.id}:${group?.members.length}`,
    );
    const availableShape = (preferred: AgentAvatarShape) => {
      if (!occupiedShapes.has(preferred)) return preferred;
      return AGENT_AVATAR_SHAPES.find((option) => !occupiedShapes.has(option)) ?? preferred;
    };
    if (agent) {
      return {
        avatarFace: agent.avatarFace,
        avatarColor: agent.avatarColor,
        avatarShape: availableShape(agent.avatarShape),
      };
    }
    if (initial?.avatarFace && initial.avatarColor) {
      return {
        avatarFace: initial.avatarFace,
        avatarColor: initial.avatarColor,
        avatarShape: availableShape(initial.avatarShape ?? seededAvatar.avatarShape),
      };
    }
    return { ...seededAvatar, avatarShape: availableShape(seededAvatar.avatarShape) };
  });
  const [name, setName] = useState(agent?.name ?? initial?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? initial?.role ?? "");
  const [instructions, setInstructions] = useState(
    agent?.instructions ?? initial?.instructions ?? "",
  );
  const [capabilities, setCapabilities] = useState(() =>
    normalizeGroupMemberCapabilities(
      agent ?? {
        ...getAgentTemplate(initial?.templateId ?? ""),
        ...initial,
      },
    ),
  );
  const [description, setDescription] = useState("");
  const [modelId, setModelId] = useState(() => {
    if (agent) return agent.modelId ?? "";
    if (initial?.modelId !== undefined) return initial.modelId ?? "";
    // A template starts on the app default model (null), like a picked card.
    if (!custom) return "";
    return models.some((model) => model.id === defaultModelId)
      ? (defaultModelId ?? "")
      : (models.find((model) => !model.locked)?.id ?? "");
  });
  const [face, setFace] = useState<AgentAvatarFace>(initialAvatar.avatarFace);
  const [color, setColor] = useState<AgentAvatarColor>(initialAvatar.avatarColor);
  const [shape, setShape] = useState<AgentAvatarShape>(initialAvatar.avatarShape);
  const [busy, setBusy] = useState<"save" | "generate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; warning: boolean } | null>(null);
  const [touched, setTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const roleId = useId();

  const takenNames = useMemo(
    () =>
      target
        ? target.takenNames
        : (group?.members ?? [])
            .filter((member) => member.agentId !== agent?.id)
            .map((m) => m.name),
    [target, group?.members, agent?.id],
  );
  const draft = { name, role, instructions, modelId };
  const problem = agentDialogError(draft, {
    custom,
    takenNames,
    availableModelIds: models.map((model) => model.id),
    savedModelId: agent?.modelId,
  });
  const savedModelMissing =
    agent?.modelId !== undefined && !models.some((model) => model.id === agent.modelId);
  const canGenerate = custom && !!name.trim() && !!modelId.trim() && busy === null;

  async function generate(): Promise<boolean> {
    setBusy("generate");
    setError(null);
    try {
      const roles = target?.roles.map((item) => item.trim()).filter(Boolean) ?? [];
      const profile = await onGenerate({
        ...(group ? { groupId: group.id } : {}),
        ...(roles.length > 0 ? { roles } : {}),
        modelId: modelId.trim(),
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(agent ? { agentId: agent.id } : {}),
      });
      setRole(profile.role);
      setInstructions(profile.instructions);
      setNotice(
        profile.generated
          ? { text: AGENT_GENERATED_HINT, warning: false }
          : { text: profile.warning ?? "Couldn't generate.", warning: true },
      );
      return true;
    } catch (caught) {
      // Model validation (agent-model-required / -unavailable) rejects before any call.
      setError(describeGroupError(caught));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function submit(): Promise<void> {
    setTouched(true);
    if (problem || busy) return;
    if (!agent && needsProfileGeneration(draft, custom)) {
      // "Generate": fill role + instructions, let the user review; the button then reads "Create".
      await generate();
      return;
    }
    const trimmedModel = modelId.trim();
    if (target) {
      // A4: added to the modal's member list; the group:create call creates it.
      target.onAdd({
        ...(initial?.templateId ? { templateId: initial.templateId } : {}),
        ...capabilities,
        name: name.trim(),
        role: role.trim(),
        instructions,
        ...(trimmedModel ? { modelId: trimmedModel } : {}),
        avatarFace: face,
        avatarColor: color,
        avatarShape: shape,
      });
      onOpenChange(false);
      return;
    }
    setBusy("save");
    setError(null);
    try {
      if (agent && props.onUpdate) {
        await props.onUpdate({
          id: agent.id,
          ...capabilities,
          name: name.trim(),
          role: role.trim(),
          instructions,
          ...(trimmedModel !== (agent.modelId ?? "") ? { modelId: trimmedModel || null } : {}),
          avatarFace: face,
          avatarColor: color,
          avatarShape: shape,
        });
      } else if (group && props.onCreate) {
        await props.onCreate({
          groupId: group.id,
          ...capabilities,
          name: name.trim(),
          role: role.trim(),
          instructions,
          modelId: trimmedModel,
          avatarFace: face,
          avatarColor: color,
          avatarShape: shape,
        });
      }
      onOpenChange(false);
    } catch (caught) {
      setError(describeGroupError(caught));
    } finally {
      setBusy(null);
    }
  }

  const shownError = error ?? (touched ? problem : null);
  const submitLabel = agent
    ? busy === "save"
      ? "Saving…"
      : "Save"
    : target
      ? busy === "generate"
        ? "Generating…"
        : needsProfileGeneration(draft, custom)
          ? "Generate"
          : "Add"
      : busy === "save"
        ? "Creating…"
        : busy === "generate"
          ? "Generating…"
          : needsProfileGeneration(draft, custom)
            ? "Generate"
            : "Create";

  const title = agent ? "Edit agent" : initial?.templateId ? "Customize agent" : "New agent";
  const subtitle = group?.name ?? target?.title;
  const form = (
    <form
      data-testid="agent-dialog"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-1">
        <AgentAvatar
          color={color}
          face={face}
          seed={agent?.id ?? group?.id ?? target?.seed ?? "agent"}
          shape={shape}
          size={48}
          state={busy === "generate" ? "working" : "idle"}
        />
        <div className="min-w-0">
          {surface === "dialog" ? (
            <>
              <Dialog.Title className="font-medium text-fg text-sm">{title}</Dialog.Title>
              <Dialog.Description className="mt-0.5 truncate text-2xs text-fg-faint">
                {subtitle}
              </Dialog.Description>
            </>
          ) : (
            <>
              <p className="font-medium text-fg text-sm">{title}</p>
              <p className="mt-0.5 truncate text-2xs text-fg-faint">{subtitle}</p>
            </>
          )}
        </div>
      </div>

      <div className="scroll-thin flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-4 pt-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-fg-subtle">Name</span>
            <input
              className={FIELD}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Ana"
              ref={nameRef}
              value={name}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-fg-subtle">Model</span>
            <select
              className={cn(FIELD, "px-2")}
              onChange={(event) => pickModel(models, event.target.value, setModelId)}
              value={modelId}
            >
              {custom ? (
                <option disabled value="">
                  {models.length === 0 ? "No model configured" : "Choose a model"}
                </option>
              ) : (
                <option value="">App default</option>
              )}
              {savedModelMissing && agent?.modelId ? (
                <option value={agent.modelId}>{agent.modelId} (unavailable)</option>
              ) : null}
              <ModelOptions models={models} />
            </select>
          </label>
        </div>

        {custom ? (
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-fg-subtle">What should it help with? (optional)</span>
            <input
              className={FIELD}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="e.g. keep the release notes and changelog tidy"
              value={description}
            />
          </label>
        ) : null}

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <label className="text-2xs text-fg-subtle" htmlFor={roleId}>
              Role
            </label>
            {custom ? (
              <button
                className="flex h-5 items-center gap-1 rounded px-1 text-2xs text-fg-subtle hover:bg-hover hover:text-fg disabled:opacity-40"
                disabled={!canGenerate}
                onClick={() => void generate()}
                title="Ask the model for a role and instructions"
                type="button"
              >
                <IconRefresh size={12} />
                {busy === "generate" ? "Generating…" : "Regenerate"}
              </button>
            ) : null}
          </div>
          <input
            className={FIELD}
            id={roleId}
            maxLength={80}
            onChange={(event) => setRole(event.target.value)}
            placeholder={custom ? "Leave empty to generate" : "e.g. Reviewer"}
            value={role}
          />
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-2xs text-fg-subtle">Instructions</span>
          <textarea
            className={cn(FIELD, "h-28 resize-none py-1.5 leading-snug")}
            maxLength={20_000}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={custom ? "Leave empty to generate" : "How this agent works"}
            value={instructions}
          />
        </label>

        <p className="text-2xs text-fg-subtle">
          Choose the work this agent supports. These choices do not grant tool access.
        </p>
        {(
          [
            ["capabilityIds", "Capabilities", "Capability", GROUP_CAPABILITY_IDS],
            ["supportedTaskKinds", "Supported task kinds", "Task kind", GROUP_SUPPORTED_TASK_KINDS],
          ] as const
        ).map(([field, title, label, options]) => (
          <fieldset className="flex flex-col gap-1" key={field} disabled={busy !== null}>
            <legend className="mb-1 text-2xs text-fg-subtle">{title}</legend>
            <div className="flex flex-wrap gap-2">
              {options.map((option) => (
                <label className="flex items-center gap-1 text-2xs" key={option}>
                  <input
                    type="checkbox"
                    aria-label={`${label} ${option}`}
                    checked={(capabilities[field] as string[]).includes(option)}
                    onChange={(event) =>
                      setCapabilities((current) =>
                        normalizeGroupMemberCapabilities({
                          ...current,
                          [field]: event.target.checked
                            ? [...current[field], option]
                            : current[field].filter((value) => value !== option),
                        }),
                      )
                    }
                  />
                  {option}
                </label>
              ))}
            </div>
          </fieldset>
        ))}

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-2xs text-fg-subtle">Face</legend>
          <div className="flex flex-wrap gap-1">
            {AGENT_AVATAR_FACES.map((option) => (
              <button
                aria-label={`Face ${option}`}
                aria-pressed={face === option}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md border transition-colors",
                  face === option
                    ? "border-accent bg-accent/10"
                    : "border-transparent hover:bg-hover",
                )}
                key={option}
                onClick={() => setFace(option)}
                type="button"
              >
                <AgentAvatar color={color} face={option} seed={option} shape={shape} size={20} />
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-2xs text-fg-subtle">Shape</legend>
          <div className="flex flex-wrap gap-1">
            {AGENT_AVATAR_SHAPES.map((option) => (
              <button
                aria-label={`Shape ${option}`}
                aria-pressed={shape === option}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md border transition-colors",
                  occupiedShapes.has(option) && shape !== option
                    ? "cursor-not-allowed border-transparent opacity-35"
                    : shape === option
                      ? "border-accent bg-accent/10"
                      : "border-transparent hover:bg-hover",
                )}
                disabled={occupiedShapes.has(option) && shape !== option}
                key={option}
                onClick={() => setShape(option)}
                title={occupiedShapes.has(option) ? "Used by another agent in this group" : option}
                type="button"
              >
                <AgentAvatar color={color} face={face} seed={option} shape={option} size={20} />
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-2xs text-fg-subtle">Color</legend>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_AVATAR_COLORS.map((option) => (
              <button
                aria-label={`Color ${option}`}
                aria-pressed={color === option}
                className={cn(
                  "size-5 rounded-md ring-offset-1 ring-offset-canvas transition-shadow",
                  color === option
                    ? "ring-2 ring-accent"
                    : "hover:ring-1 hover:ring-hairline-strong",
                )}
                key={option}
                onClick={() => setColor(option)}
                style={{ backgroundColor: AGENT_AVATAR_FILL[option] }}
                type="button"
              />
            ))}
          </div>
        </fieldset>
      </div>

      {notice ? (
        <p
          className={cn(
            "mx-4 mt-3 rounded-md px-2.5 py-1.5 text-xs",
            notice.warning
              ? "border border-amber-400/30 bg-amber-400/10 text-amber-400"
              : "text-fg-faint",
          )}
          data-testid="agent-dialog-notice"
          data-warning={notice.warning || undefined}
          role="status"
        >
          {notice.text}
        </p>
      ) : null}

      {shownError ? (
        <div
          className="mx-4 mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/8 px-2.5 py-2 text-xs text-danger"
          role="alert"
        >
          {shownError}
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
            busy === null
              ? "bg-accent text-white hover:opacity-90"
              : "cursor-not-allowed bg-chip-strong text-fg-faint",
          )}
          disabled={busy !== null}
          type="submit"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );

  if (surface === "plain") return form;

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
            "-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 w-[min(480px,calc(100vw-2rem))]",
            "origin-center overflow-hidden popup-chrome outline-none",
            "transition-[transform,opacity,scale] duration-150 ease-out-quint motion-reduce:transition-none",
            "data-ending-style:scale-[0.96] data-ending-style:opacity-0",
            "data-starting-style:scale-[0.96] data-starting-style:opacity-0",
          )}
          initialFocus={nameRef}
        >
          {form}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
