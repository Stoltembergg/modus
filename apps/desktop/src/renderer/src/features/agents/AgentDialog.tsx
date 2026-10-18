import { Dialog } from "@base-ui/react/dialog";
import { IconChevronLeft } from "@tabler/icons-react";
import { m, type Transition, useIsPresent, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENT_FACE_SEEDS, agentAvatarSeed } from "../../../../shared/agent-avatar-seeds";
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
import { shellText } from "../../../../shared/shell-text";
import { cn } from "../../lib/cn";
import { selectableModels } from "../../lib/modusModels";
import type { GroupDialogModel } from "../groups/CreateGroupDialog";
import { describeGroupError } from "../groups/groupErrors";
import { AgentAvatar } from "./AgentAvatar";
import { AvatarOptionGroup, humanizeOption } from "./AvatarOptionGroup";
import { AGENT_AVATAR_FILL } from "./agentAvatarModel";
import { agentDialogError, needsProfileGeneration } from "./agentDialogModel";
import { ModelPicker } from "./ModelPicker";

export const AGENT_GENERATED_HINT = "Generated. Review the instructions, then save.";

const FIELD = cn(
  "h-9 w-full rounded-lg border border-hairline bg-canvas/70 px-3 text-sm text-fg outline-none",
  "transition-colors duration-150 placeholder:text-fg-faint hover:border-hairline-strong",
  "focus:border-hairline-strong focus-visible:ring-2 focus-visible:ring-focus-ring/40",
);
/** Field labels: small and quiet, but readable over glass. */
const LABEL = "font-medium text-2xs text-fg-muted";
/** Subtle press feedback (transform only; none with reduced motion). */
const PRESS =
  "transition-[background-color,color,opacity,transform] duration-150 ease-out-quint active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";
/** Open/close spring of the dialog (transform + opacity only). */
const DIALOG_SPRING: Transition = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 };
const DIALOG_EXIT: Transition = { duration: 0.14, ease: [0.4, 0, 1, 1] };
/** Reduced motion: a short fade instead of the spring, never no animation at all. */
const DIALOG_FADE: Transition = { duration: 0.12, ease: "easeOut" };
/** The preview's pop when face, shape or color changes. */
const PREVIEW_SPRING: Transition = { type: "spring", stiffness: 480, damping: 26, mass: 0.7 };
const PREVIEW_SIZE = 64;

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
  /**
   * Seed for the draft's default look (agentAvatarForId) and, while it has no
   * picked face seed, its preview (the modal draws the member with its key).
   */
  seed: string;
  /** Prefill ("Customize" on a template card carries its `templateId`). */
  initial?: NewGroupAgentInput | undefined;
  onAdd(member: NewGroupAgentInput): void;
  /** `add` (default): "Add to group". `edit`: an added member, "Save changes". */
  mode?: "add" | "edit";
  /** Edit mode: "Remove from group" in the footer. */
  onRemove?(): void;
  /** A copy's source agent (the copy keeps its role, so it handles what the source handles). */
  sourceAgent?: AgentInfo | undefined;
  /** Name restored by "Use {template}'s defaults" (the next free one in the modal). */
  defaultName?: string | undefined;
  /** Quiet text in the footer (e.g. "4 of 10"). */
  footerNote?: string | undefined;
};

type AgentDialogCommonProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  models: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  /** `agents:generate-profile`: resolves the Generalist fallback on a model failure. */
  onGenerate(input: GenerateAgentProfileInput): Promise<GeneratedAgentProfile>;
  /**
   * `dialog` (default): Base UI modal. `plain`: form only, for hosts that
   * already provide chrome and focus trap (the New group modal's in-dialog
   * panel): Cancel reads "Back" and a back button leads the header.
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
  profile?: undefined;
};

type AgentDialogDraftProps = {
  draft: AgentDialogDraftTarget;
  group?: undefined;
  agent?: undefined;
  onCreate?: undefined;
  onUpdate?: undefined;
  profile?: undefined;
};

export type AgentDialogProfileProps = {
  profile: { takenNames: readonly string[] };
  group?: undefined;
  draft?: undefined;
  agent?: AgentInfo | undefined;
  onCreate(input: NewGroupAgentInput): Promise<void>;
  onUpdate(input: UpdateAgentInput & { id: string }): Promise<void>;
};

export type AgentDialogProps = AgentDialogCommonProps &
  (AgentDialogGroupProps | AgentDialogDraftProps | AgentDialogProfileProps);

/**
 * Create / edit an agent: a live, animated avatar preview centered on top
 * (it follows the face, shape and color pickers), then name, model,
 * instructions and the three pickers. There is no Role field: the role is
 * kept as stored (an edit), as the template's (a template agent), or empty
 * for a new custom agent, which therefore handles Custom's work. A custom
 * agent needs a name and a model. Creating one with empty instructions first
 * asks the model for them (shown here, editable; the button reads "Generate",
 * then "Create" saves); only the generated instructions are kept, never the
 * generated role. Render it only while open: each open starts from a fresh draft.
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
    profile,
  } = props;
  const initial = target?.initial;
  const template = getAgentTemplate(agent?.templateId ?? initial?.templateId ?? "");
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
  const availableShape = (preferred: AgentAvatarShape) => {
    if (!occupiedShapes.has(preferred)) return preferred;
    return AGENT_AVATAR_SHAPES.find((option) => !occupiedShapes.has(option)) ?? preferred;
  };
  const [initialAvatar] = useState(() => {
    const seededAvatar = agentAvatarForId(
      target
        ? target.seed
        : group
          ? `${group.id}:${group.members.length}`
          : (agent?.id ?? "profile"),
    );
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
  // No Role field: the stored role (edit), the template's (template / copy), else "" (Custom).
  // A generated role is never taken, so "Generalist" is never saved from here.
  const [role, setRole] = useState(agent?.role ?? initial?.role ?? "");
  const [instructions, setInstructions] = useState(
    agent?.instructions ?? initial?.instructions ?? "",
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
  // The avatar package seed (eyes, tone, ribbons): what the preview draws and
  // what is saved as avatar_seed. Editing starts from the stored seed (null:
  // drawn with the id). Creating starts on the default face's seed, so the
  // preview is exactly the saved avatar. Picking a face sets its seed.
  const editing = agent !== undefined || target?.mode === "edit";
  // A copy of an existing agent never gets a seed: it is drawn with its new id,
  // so its face can't be picked here (the preview would not be what is saved).
  const isCopy = target?.sourceAgent !== undefined;
  const [avatarSeed, setAvatarSeed] = useState<string | null>(() => {
    if (agent) return agent.avatarSeed;
    if (editing || isCopy) return (!isCopy && initial?.avatarSeed) || null;
    return initial?.avatarSeed || AGENT_FACE_SEEDS[initialAvatar.avatarFace];
  });
  // Edit: the seed (and face) are only sent once the face was changed.
  const [faceTouched, setFaceTouched] = useState(false);
  const previewSeed = agentAvatarSeed({
    id: agent?.id ?? target?.seed ?? "profile",
    avatarSeed,
  });
  function pickFace(next: AgentAvatarFace): void {
    if (isCopy) return;
    setFace(next);
    setAvatarSeed(AGENT_FACE_SEEDS[next]);
    setFaceTouched(true);
  }
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
  // The plain panel has no Base UI popup to apply initialFocus: focus Name on open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only.
  useEffect(() => {
    if (surface === "plain") nameRef.current?.focus();
  }, []);

  /** "Use {template}'s defaults": name, role, instructions and look, all back to the template. */
  function applyTemplateDefaults(): void {
    if (!template) return;
    setName(target?.defaultName ?? template.name);
    setRole(template.role);
    setInstructions(template.instructions);
    pickFace(template.avatarFace);
    setColor(template.avatarColor);
    setShape(availableShape(agentAvatarForId(template.id).avatarShape));
  }

  const takenNames = useMemo(
    () =>
      profile
        ? profile.takenNames.filter(
            (taken) => !agent || taken.trim().toLowerCase() !== agent.name.trim().toLowerCase(),
          )
        : target
          ? target.takenNames
          : (group?.members ?? [])
              .filter((member) => member.agentId !== agent?.id)
              .map((m) => m.name),
    [profile, target, group?.members, agent],
  );
  const draft = { name, role, instructions, modelId };
  const problem = agentDialogError(draft, {
    custom,
    takenNames,
    availableModelIds: models.map((model) => model.id),
    savedModelId: agent?.modelId,
  });

  async function generate(): Promise<boolean> {
    if (inactive()) return false;
    setBusy("generate");
    setError(null);
    try {
      const roles = target?.roles.map((item) => item.trim()).filter(Boolean) ?? [];
      const generated = await onGenerate({
        ...(group ? { groupId: group.id } : {}),
        ...(roles.length > 0 ? { roles } : {}),
        modelId,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(agent ? { agentId: agent.id } : {}),
      });
      // Only the instructions are kept: the generated role (or the "Generalist"
      // fallback) is discarded, so a new custom agent is saved with role "" (Custom).
      setInstructions(generated.instructions);
      setNotice(
        generated.generated
          ? { text: AGENT_GENERATED_HINT, warning: false }
          : { text: generated.warning ?? "Couldn't generate.", warning: true },
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
      // "Generate": fill the instructions, let the user review; the button then reads "Create".
      await generate();
      return;
    }
    const selectedModel = modelId;
    // Create: always the previewed seed. Edit: only a changed face sends its seed,
    // so an untouched edit keeps the stored seed and face exactly.
    const seedField =
      !editing || faceTouched
        ? { avatarFace: face, avatarSeed: previewSeed }
        : agent
          ? {}
          : { avatarFace: face };
    if (target) {
      // A4: added to the modal's member list; the group:create call creates it.
      closingRef.current = true; // before onAdd: a re-entrant submit must not add it twice
      target.onAdd({
        ...(initial?.templateId ? { templateId: initial.templateId } : {}),
        name: name.trim(),
        role: role.trim(),
        instructions,
        ...(selectedModel ? { modelId: selectedModel } : {}),
        ...seedField,
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
          name: name.trim(),
          role: role.trim(),
          instructions,
          ...(selectedModel !== (agent.modelId ?? "") ? { modelId: selectedModel || null } : {}),
          ...seedField,
          avatarColor: color,
          avatarShape: shape,
        });
      } else if (profile && props.onCreate) {
        await props.onCreate({
          name: name.trim(),
          role: role.trim(),
          instructions,
          modelId: selectedModel,
          ...seedField,
          avatarColor: color,
          avatarShape: shape,
        });
      } else if (group && props.onCreate) {
        await props.onCreate({
          groupId: group.id,
          name: name.trim(),
          role: role.trim(),
          instructions,
          modelId: selectedModel,
          ...seedField,
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
        : target.mode === "edit"
          ? "Save changes"
          : needsProfileGeneration(draft, custom)
            ? "Generate"
            : "Add to group"
      : busy === "save"
        ? "Creating…"
        : busy === "generate"
          ? "Generating…"
          : needsProfileGeneration(draft, custom)
            ? "Generate"
            : "Create";

  const title = profile
    ? shellText(agent ? "shell.editProfile" : "shell.newProfile")
    : agent || target?.mode === "edit"
      ? "Edit agent"
      : initial?.templateId
        ? "Customize agent"
        : "New agent";
  const subtitle = group?.name ?? target?.title;
  // The preview pops on each face / shape / color change (not on open).
  const look = `${previewSeed}:${shape}:${color}`;
  const [openedLook] = useState(look);
  const changed = look !== openedLook;
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
      {/* No visible title: the live avatar leads; the title stays for assistive tech. */}
      {surface === "dialog" ? (
        <>
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {subtitle ? (
            <Dialog.Description className="sr-only">{subtitle}</Dialog.Description>
          ) : null}
        </>
      ) : (
        <h2 className="sr-only">{title}</h2>
      )}
      <div className="relative flex items-center justify-center px-5 pt-6 pb-2">
        {surface === "plain" ? (
          <button
            aria-label="Back"
            className={cn(
              "absolute top-4 left-4 flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg",
              PRESS,
            )}
            onClick={() => {
              if (!inactive()) close();
            }}
            type="button"
          >
            <IconChevronLeft size={16} />
          </button>
        ) : null}
        <m.div
          animate={{ opacity: 1, scale: 1 }}
          data-testid="agent-dialog-preview"
          initial={
            changed ? (reduceMotion ? { opacity: 0.4 } : { opacity: 0.6, scale: 0.86 }) : false
          }
          key={look}
          transition={reduceMotion ? DIALOG_FADE : PREVIEW_SPRING}
        >
          <AgentAvatar
            color={color}
            face={face}
            // Exactly the saved avatar: its seed (a picked face's, else the stored one / the id).
            seed={previewSeed}
            shape={shape}
            size={PREVIEW_SIZE}
            state={busy === "generate" ? "working" : "idle"}
          />
        </m.div>
        {/* New group panel only: the standalone Edit agent dialog has no "defaults" to go back to. */}
        {template && target ? (
          <button
            className={cn(
              "absolute top-4 right-4 rounded-md px-1.5 py-1 font-medium text-accent text-xs hover:bg-hover",
              PRESS,
            )}
            onClick={applyTemplateDefaults}
            title="Resets the name, instructions and look"
            type="button"
          >
            Use {template.name}'s defaults
          </button>
        ) : null}
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

        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Instructions</span>
          <textarea
            // Grows with the text up to 12 lines, then scrolls (field-sizing: Chromium 123+).
            className={cn(
              FIELD,
              "h-auto max-h-[calc(12lh+1rem)] min-h-28 resize-none overflow-y-auto py-2 leading-relaxed [field-sizing:content]",
            )}
            data-testid="agent-instructions"
            maxLength={20_000}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={custom ? "Leave empty to generate" : "How this agent works"}
            value={instructions}
          />
        </label>

        <AvatarOptionGroup
          disabledTitle="A copy gets its own face from its new id"
          isDisabled={() => isCopy}
          label="Face"
          onChange={pickFace}
          optionLabel={humanizeOption}
          options={AGENT_AVATAR_FACES}
          renderOption={(option) => (
            // The full avatar this face saves (its seed), in the current color and shape.
            <AgentAvatar
              color={color}
              face={option}
              seed={AGENT_FACE_SEEDS[option]}
              shape={shape}
              size={20}
            />
          )}
          value={face}
        />
        <AvatarOptionGroup
          disabledTitle="Used by another agent in this group"
          isDisabled={(option) => occupiedShapes.has(option)}
          label="Shape"
          onChange={setShape}
          optionLabel={humanizeOption}
          options={AGENT_AVATAR_SHAPES}
          renderOption={(option) => (
            <AgentAvatar color={color} face={face} seed={previewSeed} shape={option} size={20} />
          )}
          value={shape}
        />
        <AvatarOptionGroup
          label="Color"
          onChange={setColor}
          optionLabel={humanizeOption}
          options={AGENT_AVATAR_COLORS}
          renderOption={(option) => (
            <span
              className="block size-full rounded-full"
              style={{ backgroundColor: AGENT_AVATAR_FILL[option] }}
            />
          )}
          value={color}
          variant="swatch"
        />
      </div>

      {notice ? (
        <p
          className={cn(
            "mx-5 mt-3 rounded-lg px-2.5 py-1.5 text-xs",
            notice.warning
              ? "border border-dialog-warning/30 bg-dialog-warning/10 text-dialog-warning"
              : "text-fg-muted",
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

      <div className="mt-2 flex items-center justify-end gap-2 px-5 pt-3 pb-5">
        {target?.onRemove ? (
          <button
            className={cn(
              "mr-auto h-8 rounded-lg px-2.5 text-danger text-xs hover:bg-danger/8",
              PRESS,
            )}
            onClick={() => {
              if (inactive()) return;
              closingRef.current = true;
              target.onRemove?.();
            }}
            type="button"
          >
            Remove from group
          </button>
        ) : null}
        {target?.footerNote ? (
          <span
            className="text-fg-faint text-xs tabular-nums"
            data-testid="agent-dialog-footer-note"
          >
            {target.footerNote}
          </span>
        ) : null}
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
          {surface === "plain" ? "Back" : "Cancel"}
        </button>
        <button
          className={cn(
            "h-8 rounded-lg px-3.5 font-medium text-xs",
            PRESS,
            busy === null
              ? "bg-accent text-on-accent hover:opacity-90"
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
              exit={{ opacity: 0, transition: reduceMotion ? DIALOG_FADE : DIALOG_EXIT }}
              initial={{ opacity: 0 }}
              transition={reduceMotion ? DIALOG_FADE : { duration: 0.18, ease: "easeOut" }}
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
                  ? { opacity: 0, transition: DIALOG_FADE }
                  : { opacity: 0, scale: 0.97, y: 4, transition: DIALOG_EXIT }
              }
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
              transition={reduceMotion ? DIALOG_FADE : DIALOG_SPRING}
            />
          }
        >
          {form}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
