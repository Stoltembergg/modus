import { Dialog } from "@base-ui/react/dialog";
import { IconRefresh } from "@tabler/icons-react";
import { m, type Transition, useIsPresent, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { selectableModels } from "../../lib/modusModels";
import type { GroupDialogModel } from "../groups/CreateGroupDialog";
import { describeGroupError } from "../groups/groupErrors";
import { useGroupText } from "../groups/groupRoomI18n";
import { AgentAvatar } from "./AgentAvatar";
import { AGENT_AVATAR_FILL } from "./agentAvatarModel";
import { agentDialogError, needsProfileGeneration } from "./agentDialogModel";
import { ModelPicker } from "./ModelPicker";

export const AGENT_GENERATED_HINT = "Generated. Review the role and instructions, then save.";

const FIELD = cn(
  "h-9 w-full rounded-lg border border-hairline bg-canvas/70 px-3 text-sm text-fg outline-none",
  "transition-colors duration-150 placeholder:text-fg-faint hover:border-hairline-strong",
  "focus:border-hairline-strong focus-visible:ring-2 focus-visible:ring-focus-ring/40",
);
/** Field and section labels: small, quiet, a little air below. */
const LABEL = "font-medium text-2xs text-fg-subtle";
/** Subtle press feedback (transform only; none with reduced motion). */
const PRESS =
  "transition-[background-color,color,opacity,transform] duration-150 ease-out-quint active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";
/** Open/close spring of the dialog (transform + opacity only). */
const DIALOG_SPRING: Transition = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 };
const DIALOG_EXIT: Transition = { duration: 0.14, ease: [0.4, 0, 1, 1] };

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
    models: allModels,
    defaultModelId,
    onGenerate,
    draft: target,
  } = props;
  const initial = target?.initial;
  const t = useGroupText();
  const capabilityTemplate = getAgentTemplate(agent?.templateId ?? initial?.templateId ?? "");
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
  // Locked Modus models are not offered (nor valid for a new pick); the saved one stays.
  const models = selectableModels(allModels);
  const [modelId, setModelId] = useState(() => {
    if (agent) return agent.modelId ?? "";
    if (initial?.modelId !== undefined) return initial.modelId ?? "";
    // A template starts on the app default model (null), like a picked card.
    if (!custom) return "";
    return defaultModelId && models.some((model) => model.id === defaultModelId)
      ? defaultModelId
      : "";
  });
  const [face, setFace] = useState<AgentAvatarFace>(initialAvatar.avatarFace);
  const [color, setColor] = useState<AgentAvatarColor>(initialAvatar.avatarColor);
  const [shape, setShape] = useState<AgentAvatarShape>(initialAvatar.avatarShape);
  const [busy, setBusy] = useState<"save" | "generate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; warning: boolean } | null>(null);
  const [touched, setTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();
  // Exit guard: once the dialog has saved / added / cancelled (closingRef, set synchronously)
  // or its host's AnimatePresence is playing the exit (isPresent false), it must not act again;
  // otherwise a second click during the ~140 ms exit would save or add the member twice.
  const isPresent = useIsPresent();
  const closingRef = useRef(false);
  const inactive = () => closingRef.current || !isPresent;
  useEffect(() => {
    // Re-entered while exiting (same instance brought back): usable again.
    if (isPresent && closingRef.current) {
      closingRef.current = false;
      setBusy(null);
    }
  }, [isPresent]);
  function close(): void {
    closingRef.current = true;
    onOpenChange(false);
  }
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
  const canGenerate = custom && !!name.trim() && !!modelId.trim() && busy === null;

  async function generate(): Promise<boolean> {
    if (inactive()) return false;
    setBusy("generate");
    setError(null);
    try {
      const roles = target?.roles.map((item) => item.trim()).filter(Boolean) ?? [];
      const profile = await onGenerate({
        ...(group ? { groupId: group.id } : {}),
        ...(roles.length > 0 ? { roles } : {}),
        modelId,
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
    if (inactive()) return;
    setTouched(true);
    if (problem || busy) return;
    if (!agent && needsProfileGeneration(draft, custom)) {
      // "Generate": fill role + instructions, let the user review; the button then reads "Create".
      await generate();
      return;
    }
    const selectedModel = modelId;
    if (target) {
      // A4: added to the modal's member list; the group:create call creates it.
      closingRef.current = true; // before onAdd: a re-entrant submit must not add it twice
      target.onAdd({
        ...(initial?.templateId ? { templateId: initial.templateId } : {}),
        ...capabilities,
        name: name.trim(),
        role: role.trim(),
        instructions,
        ...(selectedModel ? { modelId: selectedModel } : {}),
        avatarFace: face,
        avatarColor: color,
        avatarShape: shape,
      });
      close();
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
          ...(selectedModel !== (agent.modelId ?? "") ? { modelId: selectedModel || null } : {}),
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
          modelId: selectedModel,
          avatarFace: face,
          avatarColor: color,
          avatarShape: shape,
        });
      }
      close();
    } catch (caught) {
      setError(describeGroupError(caught));
    } finally {
      // After a save the dialog is leaving: keep the button disabled through the exit.
      if (!closingRef.current) setBusy(null);
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
      aria-hidden={isPresent ? undefined : true}
      data-testid="agent-dialog"
      inert={!isPresent}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-3.5 px-5 pt-5 pb-2">
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
              <Dialog.Title className="font-semibold text-[15px] text-fg tracking-tight">
                {title}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 truncate text-xs text-fg-faint">
                {subtitle}
              </Dialog.Description>
            </>
          ) : (
            <>
              <p className="font-semibold text-[15px] text-fg tracking-tight">{title}</p>
              <p className="mt-0.5 truncate text-xs text-fg-faint">{subtitle}</p>
            </>
          )}
        </div>
      </div>

      <div className="scroll-thin flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-5 pt-3 pb-1">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Name</span>
            <input
              className={FIELD}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Ana"
              ref={nameRef}
              value={name}
            />
          </label>
          <div className="flex min-w-0 flex-col gap-1.5">
            <ModelPicker
              defaultLabel={custom ? undefined : "App default"}
              label="Model"
              models={allModels}
              onValueChange={setModelId}
              placeholder={models.length === 0 ? "No model configured" : "Choose a model"}
              savedModelId={agent ? agent.modelId : initial?.modelId}
              value={modelId}
            />
          </div>
        </div>

        {custom ? (
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>What should it help with? (optional)</span>
            <input
              className={FIELD}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="e.g. keep the release notes and changelog tidy"
              value={description}
            />
          </label>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className={LABEL} htmlFor={roleId}>
              Role
            </label>
            {custom ? (
              <button
                className={cn(
                  "-my-0.5 flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs text-fg-subtle hover:bg-hover hover:text-fg disabled:opacity-40",
                  PRESS,
                )}
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

        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Instructions</span>
          <textarea
            className={cn(FIELD, "h-28 resize-none py-2 leading-relaxed")}
            maxLength={20_000}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={custom ? "Leave empty to generate" : "How this agent works"}
            value={instructions}
          />
        </label>

        <p className="mt-1 text-2xs text-fg-faint">
          Choose the work this agent supports. These choices do not grant tool access.
        </p>
        {(!capabilities.capabilityIds.length || !capabilities.supportedTaskKinds.length) && (
          <p className="text-2xs text-warning">{t("agents.capabilitiesUnconfigured")}</p>
        )}
        {capabilityTemplate && (
          <div className="flex flex-col items-start gap-1">
            <button
              type="button"
              className={cn(
                "rounded-lg border border-hairline px-2.5 py-1 text-2xs text-fg-subtle hover:border-hairline-strong hover:text-fg",
                PRESS,
              )}
              disabled={busy !== null}
              onClick={() => setCapabilities(normalizeGroupMemberCapabilities(capabilityTemplate))}
            >
              {t("agents.applyTemplateCapabilities", { name: capabilityTemplate.name })}
            </button>
            <span className="text-2xs text-fg-subtle">{t("agents.templateCapabilitiesHint")}</span>
          </div>
        )}
        {(
          [
            ["capabilityIds", "Capabilities", "Capability", GROUP_CAPABILITY_IDS],
            ["supportedTaskKinds", "Supported task kinds", "Task kind", GROUP_SUPPORTED_TASK_KINDS],
          ] as const
        ).map(([field, title, label, options]) => (
          <fieldset className="flex flex-col gap-1" key={field} disabled={busy !== null}>
            <legend className={cn(LABEL, "mb-1.5")}>{title}</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {options.map((option) => (
                <label className="flex items-center gap-1.5 text-2xs text-fg-muted" key={option}>
                  <input
                    className="size-3.5 accent-accent"
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
          <legend className={cn(LABEL, "mb-1.5")}>Face</legend>
          <div className="flex flex-wrap gap-1">
            {AGENT_AVATAR_FACES.map((option) => (
              <button
                aria-label={`Face ${option}`}
                aria-pressed={face === option}
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg border",
                  PRESS,
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
          <legend className={cn(LABEL, "mb-1.5")}>Shape</legend>
          <div className="flex flex-wrap gap-1">
            {AGENT_AVATAR_SHAPES.map((option) => (
              <button
                aria-label={`Shape ${option}`}
                aria-pressed={shape === option}
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg border",
                  PRESS,
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
          <legend className={cn(LABEL, "mb-1.5")}>Color</legend>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_AVATAR_COLORS.map((option) => (
              <button
                aria-label={`Color ${option}`}
                aria-pressed={color === option}
                className={cn(
                  "size-5 rounded-md ring-offset-2 ring-offset-elevated transition-[box-shadow,transform] duration-150 ease-out-quint active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100",
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
            "mx-5 mt-3 rounded-lg px-2.5 py-1.5 text-xs",
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
          className="mx-5 mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg border border-danger/30 bg-danger/8 px-2.5 py-2 text-xs text-danger"
          role="alert"
        >
          {shownError}
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2 border-hairline-soft border-t px-5 py-3">
        <button
          className={cn(
            "h-8 rounded-lg px-3.5 text-xs text-fg-muted hover:bg-hover hover:text-fg",
            PRESS,
          )}
          onClick={() => {
            if (!inactive()) close();
          }}
          type="button"
        >
          Cancel
        </button>
        <button
          className={cn(
            "h-8 rounded-lg px-3.5 font-medium text-xs",
            PRESS,
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
          className="dialog-scrim fixed inset-0 z-50"
          data-testid="agent-dialog-backdrop"
          render={
            <m.div
              animate={{ opacity: 1 }}
              exit={reduceMotion ? { opacity: 1 } : { opacity: 0, transition: DIALOG_EXIT }}
              initial={reduceMotion ? false : { opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            />
          }
        />
        <Dialog.Popup
          className={cn(
            "-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 w-[min(500px,calc(100vw-2rem))]",
            "origin-center overflow-hidden popup-chrome surface-dialog outline-none",
          )}
          initialFocus={nameRef}
          render={
            <m.div
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={
                reduceMotion
                  ? { opacity: 1 }
                  : { opacity: 0, scale: 0.97, y: 4, transition: DIALOG_EXIT }
              }
              initial={reduceMotion ? false : { opacity: 0, scale: 0.96, y: 8 }}
              transition={DIALOG_SPRING}
            />
          }
        >
          {form}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
