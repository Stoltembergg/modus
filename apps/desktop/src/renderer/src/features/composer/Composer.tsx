import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import {
  IconChevronDown,
  IconDots,
  IconListCheck,
  IconLoader2,
  IconPlugConnected,
  IconPlus,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { AnimatePresence, m } from "motion/react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import type {
  AgentMode,
  ContextItem,
  ContextUsageInfo,
  ModelInfo,
  PromptDelivery,
  PromptImageAttachment,
  SkillSelection,
} from "../../../../shared/contracts";
import { GroupMenuItem } from "../../components/sidebar-groups/helpers";
import { ComposerRunningSweep } from "../../components/ui/ComposerRunningSweep";
import { ImageThumb } from "../../components/ui/ImageViewer";
import { SendStopIcon } from "../../components/ui/SendStopIcon";
import { cn } from "../../lib/cn";
import { ContextUsageRing, contextUsagePercent, formatUsagePercent } from "../../lib/contextUsage";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { useWidthTier } from "../../lib/useWidthTier";
import { ContextMentionMenu } from "./ContextMentionMenu";
import { contextItemKey } from "./composerTokens";
import { COMPOSER_TOOLBAR_BREAKPOINTS, ComposerToolbarTierContext } from "./composerToolbarTier";
import { MentionEditor, type MentionEditorHandle, type MentionEditorPart } from "./MentionEditor";
import { SlashMenu } from "./SlashMenu";
import {
  type ComposerImage,
  type ComposerImageUpdate,
  useComposerImages,
} from "./useComposerImages";
import { type MentionRow, useComposerMentions } from "./useComposerMentions";
import { type SlashActionItem, type SlashItem, useComposerSlash } from "./useComposerSlash";

const COMPOSER_PLACEHOLDER = "What will you build with Modus?";

/** Shared with read-only user bubbles — single radius/chrome truth for the prompt shell. */
export const COMPOSER_RADIUS_CLASS = "rounded-composer";
export const COMPOSER_SHELL_CLASS = cn(
  "border border-composer-border bg-surface shadow-composer-edge",
  COMPOSER_RADIUS_CLASS,
);

type ComposerProps = {
  model: string;
  models: ModelInfo[];
  contextItems: ContextItem[];
  contextUsage?: ContextUsageInfo;
  workspaceId: string | undefined;
  cwd: string | undefined;
  canSubmit: boolean;
  isRunning?: boolean;
  footer?: ReactNode;
  /** Input content shares the single elevated shell owned by ComposerDock. */
  integrated?: boolean;
  trailingActions?: ReactNode;
  /** Opens the first-class Connections view for Composio and provider access. */
  onOpenConnections?(): void;
  /**
   * L2: the composer has NO model or effort picker for anyone; the model comes from the
   * default (Settings › Model & Provider / plan default). Only the branch picker remains,
   * rendered by the host (session state) in this slot.
   */
  branchControl?: ReactNode;
  onContextChange(items: ContextItem[]): void;
  onSubmit(
    message: string,
    context: ContextItem[],
    delivery?: PromptDelivery,
    attachments?: PromptImageAttachment[],
    skills?: SkillSelection[],
    mode?: AgentMode,
  ): void | Promise<void>;
  onCompact?(): Promise<void>;
  onAbort?(): void;
  /**
   * When set, this instance is an inline edit-resend surface (same chrome as
   * the dock). Esc / the X control cancel; dock-only mode/model chrome is omitted.
   */
  onCancel?(): void;
  /** Controlled composer mode (build/plan); falls back to internal state. */
  mode?: AgentMode;
  onModeChange?(mode: AgentMode): void;
  /** Optional per-session draft, owned by the caller when the composer can unmount. */
  draft?: ComposerDraft;
  onDraftChange?(update: ComposerDraftUpdate): void;
};

export function cycleComposerMode(mode: AgentMode): AgentMode {
  if (mode === "build") return "plan";
  if (mode === "plan") return "spec";
  return "build";
}

export type ComposerDraft = {
  value: string;
  images: ComposerImage[];
  selectedSkills: SkillSelection[];
  parts?: MentionEditorPart[] | undefined;
};

export type ComposerDraftUpdate = ComposerDraft | ((current: ComposerDraft) => ComposerDraft);

export function createEmptyComposerDraft(): ComposerDraft {
  return { value: "", images: [], selectedSkills: [] };
}

function inlinePartLabel(part: MentionEditorPart): string | undefined {
  if (part.type === "context") {
    // Design marks keep a short in-flow label. Every other context kind is shown
    // via chips; the model payload travels on `context[]` IPC — omit from body.
    // Returning undefined used to become the literal "[context]" placeholder.
    if (part.item.type === "design-element") {
      return (
        part.item.element.componentName || part.item.element.tagName || part.item.element.label
      );
    }
    if (part.item.type === "design-annotation") {
      return part.item.annotation.label;
    }
    return "";
  }
  if (part.type === "skill") {
    return `skill:${part.skill.name}`;
  }
  return undefined;
}

export function messageFromParts(parts: MentionEditorPart[] | undefined, fallback: string): string {
  if (!parts || parts.length === 0) {
    return fallback;
  }
  return parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      const label = inlinePartLabel(part);
      if (label === "") {
        return "";
      }
      return `[${label ?? "context"}]`;
    })
    .join("")
    .replace(/\u00a0/g, " ")
    .trim();
}

function resolveUpdate<T>(update: T | ((current: T) => T), current: T): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

export function Composer({
  model,
  models,
  contextItems,
  contextUsage,
  workspaceId,
  cwd,
  canSubmit,
  footer,
  integrated = false,
  trailingActions,
  isRunning = false,
  onAbort,
  branchControl,
  onOpenConnections,
  onContextChange,
  onCompact,
  onSubmit,
  onCancel,
  mode: controlledMode,
  onModeChange,
  draft,
  onDraftChange,
}: ComposerProps) {
  const isInlineEdit = Boolean(onCancel);
  const [uncontrolledDraft, setUncontrolledDraft] =
    useState<ComposerDraft>(createEmptyComposerDraft);
  const activeDraft = draft ?? uncontrolledDraft;
  const [dragging, setDragging] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [internalMode, setInternalMode] = useState<AgentMode>("build");
  const mode = controlledMode ?? internalMode;
  const setDraft = useCallback(
    (update: ComposerDraftUpdate): void => {
      if (onDraftChange) {
        onDraftChange(update);
      } else {
        setUncontrolledDraft(update);
      }
    },
    [onDraftChange],
  );
  const setValue = useCallback(
    (update: string | ((current: string) => string)): void => {
      setDraft((current) => ({ ...current, value: resolveUpdate(update, current.value) }));
    },
    [setDraft],
  );
  const setSelectedSkills = useCallback(
    (update: SkillSelection[] | ((current: SkillSelection[]) => SkillSelection[])): void => {
      setDraft((current) => ({
        ...current,
        selectedSkills: resolveUpdate(update, current.selectedSkills),
      }));
    },
    [setDraft],
  );
  const setImages = useCallback(
    (update: ComposerImageUpdate): void => {
      setDraft((current) => ({ ...current, images: resolveUpdate(update, current.images) }));
    },
    [setDraft],
  );
  const setMode = (next: AgentMode): void => {
    onModeChange?.(next);
    if (controlledMode === undefined) {
      setInternalMode(next);
    }
  };
  const editorRef = useRef<MentionEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [toolbarRef, toolbarTier] = useWidthTier<HTMLDivElement>(COMPOSER_TOOLBAR_BREAKPOINTS);
  // sm: secondary actions (Attach, Connections) collapse into one overflow menu.
  const toolbarOverflow = toolbarTier === "sm" && !isInlineEdit;
  const { addFiles, clearImages, images, removeImage, toAttachments, updateImage } =
    useComposerImages({
      images: activeDraft.images,
      onImagesChange: setImages,
    });
  const value = activeDraft.value;
  const selectedSkills = activeDraft.selectedSkills;
  const [textBeforeCaret, setTextBeforeCaret] = useState(value);
  const hasText = value.trim().length > 0;
  const hasImages = images.length > 0;
  const hasSelectedSkills = selectedSkills.length > 0;
  const hasInlineTokens = contextItems.length > 0 || hasSelectedSkills;
  const hasContent = hasText || hasImages || contextItems.length > 0 || hasSelectedSkills;
  const currentModel = models.find((item) => item.id === model);
  const {
    activeIndex,
    isOpen,
    mention,
    rows: mentionRows,
    setActiveIndex,
    moveActive,
    openCategory,
    backToRoot,
    atCategoryRoot,
    expandMore,
  } = useComposerMentions({
    cwd,
    value: textBeforeCaret,
    workspaceId,
  });
  const usagePercent = contextUsagePercent(contextUsage);
  const usageLabel =
    usagePercent === undefined ? "" : ` (${formatUsagePercent(usagePercent)} full)`;
  const slashActions: SlashActionItem[] = onCompact
    ? [
        {
          kind: "action",
          key: "action:compact",
          name: "Compact",
          description: `Compact this chat's context${usageLabel}`,
          disabled: isRunning,
          leading: <ContextUsageRing percent={usagePercent} />,
          run: onCompact,
        },
      ]
    : [];
  const slash = useComposerSlash({ actions: slashActions, cwd, value: textBeforeCaret });

  function send(delivery: PromptDelivery = isRunning ? "follow-up" : "normal"): void {
    if (!hasContent || !canSubmit || submitting || !model) {
      return;
    }
    // Providers reject empty text blocks, so image-only sends get a stub line.
    const message = hasText
      ? messageFromParts(activeDraft.parts, value.trim())
      : hasSelectedSkills
        ? "Use the selected skill(s)."
        : hasImages
          ? "See the attached image(s)."
          : "Use the selected context.";
    const attachments = toAttachments();
    const payload = {
      message,
      contextItems,
      delivery,
      attachments: attachments.length > 0 ? attachments : undefined,
      skills: selectedSkills.length > 0 ? selectedSkills : undefined,
      mode,
    } as const;

    if (isInlineEdit) {
      setSubmitError(undefined);
      setSubmitting(true);
      void Promise.resolve(
        onSubmit(
          payload.message,
          payload.contextItems,
          payload.delivery,
          payload.attachments,
          payload.skills,
          payload.mode,
        ),
      )
        .then(() => {
          // Success unmounts this surface via timeline reload — skip clear flash.
        })
        .catch((cause: unknown) => {
          setSubmitError(cause instanceof Error ? cause.message : String(cause));
          setSubmitting(false);
        });
      return;
    }

    onSubmit(
      payload.message,
      payload.contextItems,
      payload.delivery,
      payload.attachments,
      payload.skills,
      payload.mode,
    );
    setValue("");
    clearImages();
    setSelectedSkills([]);
    onContextChange([]);
    editorRef.current?.clear();
  }

  function selectSlashItem(item: SlashItem): void {
    if (item.kind === "action") {
      if (item.disabled) return;
      editorRef.current?.deleteBeforeCaret((slash.query?.length ?? 0) + 1);
      setSubmitError(undefined);
      void item
        .run()
        .catch((cause: unknown) =>
          setSubmitError(cause instanceof Error ? cause.message : String(cause)),
        );
      return;
    }
    if (item.kind === "skill") {
      if (selectedSkills.some((skill) => skill.path === item.skill.path)) {
        editorRef.current?.deleteBeforeCaret((slash.query?.length ?? 0) + 1);
        return;
      }
      editorRef.current?.insertSkillToken(
        { name: item.skill.name, path: item.skill.path },
        (slash.query?.length ?? 0) + 1,
      );
      return;
    }
    // Commands seed the composer with their instruction prefix to keep typing.
    editorRef.current?.insertText(item.command.prefix, (slash.query?.length ?? 0) + 1);
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>): void {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    setDragging(false);
    if (event.dataTransfer.files.length > 0) {
      event.preventDefault();
      void addFiles(event.dataTransfer.files);
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
      event.preventDefault();
      setDragging(true);
    }
  }

  function addContextItem(item: ContextItem): void {
    const key = contextItemKey(item);
    if (!contextItems.some((existing) => contextItemKey(existing) === key)) {
      editorRef.current?.insertContextToken(item, mention ? mention.query.length + 1 : 0);
      return;
    }
    if (mention) {
      editorRef.current?.deleteBeforeCaret(mention.query.length + 1);
    }
  }

  /** Route an @-menu row: drill into a category, add an item, or expand "more". */
  function selectMentionRow(row: MentionRow): void {
    if (row.row === "nav") {
      openCategory(row.target);
    } else if (row.row === "add") {
      addContextItem(row.item);
    } else if (row.row === "more") {
      expandMore();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Shift+Tab rotates Build, Plan, and Spec modes.
    if (event.key === "Tab" && event.shiftKey && !slash.isOpen && !isOpen) {
      event.preventDefault();
      setMode(cycleComposerMode(mode));
      return;
    }

    if (slash.isOpen && event.key === "ArrowDown") {
      event.preventDefault();
      slash.setActiveIndex((index) => (index + 1) % slash.items.length);
      return;
    }

    if (!value && event.key === "Backspace") {
      if (selectedSkills.length > 0) {
        event.preventDefault();
        setSelectedSkills((current) => current.slice(0, -1));
        return;
      }
      const lastContextItem = contextItems.at(-1);
      if (lastContextItem) {
        event.preventDefault();
        const key = contextItemKey(lastContextItem);
        onContextChange(contextItems.filter((item) => contextItemKey(item) !== key));
        return;
      }
    }

    if (slash.isOpen && event.key === "ArrowUp") {
      event.preventDefault();
      slash.setActiveIndex((index) => (index - 1 + slash.items.length) % slash.items.length);
      return;
    }

    if (slash.isOpen && event.key === "Escape") {
      event.preventDefault();
      editorRef.current?.deleteBeforeCaret((slash.query?.length ?? 0) + 1);
      return;
    }

    if (slash.isOpen && (event.key === "Enter" || event.key === "Tab")) {
      const item = slash.items[slash.activeIndex];
      if (item) {
        event.preventDefault();
        selectSlashItem(item);
        return;
      }
    }

    if (isOpen && event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }

    if (isOpen && event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }

    // Backspace at a category's empty query pops back to the root @ menu.
    if (isOpen && atCategoryRoot && event.key === "Backspace") {
      event.preventDefault();
      backToRoot();
      return;
    }

    if (isOpen && event.key === "Escape") {
      event.preventDefault();
      editorRef.current?.deleteBeforeCaret(mention ? mention.query.length + 1 : 0);
      return;
    }

    if (isOpen && (event.key === "Enter" || event.key === "Tab")) {
      const row = mentionRows[activeIndex];
      if (row && row.row !== "header") {
        event.preventDefault();
        selectMentionRow(row);
        return;
      }
    }

    if (event.key === "Escape" && onCancel && !submitting) {
      event.preventDefault();
      onCancel();
      return;
    }

    if (event.key === "Escape" && isRunning && onAbort) {
      event.preventDefault();
      onAbort();
      return;
    }

    if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "g" &&
      isRunning &&
      onAbort
    ) {
      event.preventDefault();
      onAbort();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(event.ctrlKey && isRunning ? "steer" : undefined);
    }
  }

  function handleEditorChange(
    text: string,
    items: ContextItem[],
    skills: SkillSelection[],
    nextTextBeforeCaret: string,
    parts: MentionEditorPart[],
  ): void {
    setDraft((current) => ({ ...current, value: text, selectedSkills: skills, parts }));
    onContextChange(items);
    setTextBeforeCaret(nextTextBeforeCaret);
  }

  return (
    <div className="relative flex flex-col items-stretch">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-drop is a pointer-only enhancement; keyboard users attach images via paste in the editor. */}
      <div
        className={cn(
          "composer-prompt-shell relative transition-[border-color] duration-150",
          integrated
            ? "border-0 bg-transparent shadow-none"
            : "border border-composer-border bg-surface shadow-composer-edge",
          !integrated && COMPOSER_RADIUS_CLASS,
          !integrated && Boolean(footer) && "z-10",
          // No focus glow: only text focus or drag nudges the border one notch brighter.
          !isRunning && "focus-within:border-composer-border-strong",
          dragging && "border-composer-border-strong",
          submitting && "pointer-events-none opacity-60",
        )}
        {...(!integrated ? { "data-composer-surface": "" } : {})}
        onDragLeave={() => setDragging(false)}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <AnimatePresence>
          {isRunning ? <ComposerRunningSweep key="composer-running" /> : null}
        </AnimatePresence>
        <div
          className="relative z-10"
          onCompositionEnd={() => setIsComposing(false)}
          onCompositionStart={() => setIsComposing(true)}
        >
          {!hasText && !hasInlineTokens && !isComposing ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 px-4 pt-3 text-md font-light text-fg-placeholder leading-normal"
            >
              {COMPOSER_PLACEHOLDER}
            </div>
          ) : null}
          {/* One typing line + airy pad (top/bottom) — not a multi-line empty runway. */}
          <MentionEditor
            className="min-h-[calc(1lh+1.25rem)] px-4 pt-3 pb-2 text-md font-normal text-fg leading-normal"
            contextItems={contextItems}
            onChange={handleEditorChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            parts={activeDraft.parts}
            ref={editorRef}
            skills={selectedSkills}
            value={value}
          />
          <ContextMentionMenu
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onSelect={selectMentionRow}
            rows={isOpen ? mentionRows : []}
          />
          {slash.isOpen ? (
            <SlashMenu
              activeIndex={slash.activeIndex}
              items={slash.items}
              onSelect={selectSlashItem}
            />
          ) : null}
        </div>

        {images.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3 pt-1.5">
            <AnimatePresence initial={false}>
              {images.map((image) => (
                <m.div
                  animate={{ opacity: 1, scale: 1 }}
                  className="group/image relative"
                  exit={{ opacity: 0, scale: 0.92 }}
                  initial={{ opacity: 0, scale: 0.92 }}
                  key={image.id}
                  layout
                  transition={{ duration: 0.14, ease: "easeOut" }}
                >
                  <ImageThumb
                    alt={image.name}
                    className="size-14 rounded-lg border border-hairline bg-canvas object-contain"
                    onSaveEdited={(dataUrl) => updateImage(image.id, dataUrl)}
                    src={image.dataUrl}
                    title={image.name}
                  />
                  <button
                    aria-label={`Remove ${image.name}`}
                    className="absolute -top-1.5 -right-1.5 flex size-4.5 items-center justify-center rounded-full border border-hairline bg-elevated text-fg-faint opacity-0 transition-opacity hover:text-fg group-hover/image:opacity-100"
                    onClick={() => removeImage(image.id)}
                    type="button"
                  >
                    <IconX size={ICON.xs} stroke={ICON_STROKE.xs} />
                  </button>
                </m.div>
              ))}
            </AnimatePresence>
          </div>
        ) : null}

        {/* L3c: the toolbar collapses by its own width (composerToolbarTier.ts), not the
          viewport's: labels to icons, then secondary actions into "More actions". */}
        <ComposerToolbarTierContext.Provider value={toolbarTier}>
          <div
            className="flex min-w-0 items-center gap-1 px-3 pt-1.5 pb-2.5"
            data-testid="composer-toolbar"
            data-width-tier={toolbarTier}
            ref={toolbarRef}
          >
            {toolbarOverflow ? (
              <Menu.Root>
                <Menu.Trigger
                  aria-label="More actions"
                  className="app-no-drag flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ring/50 data-popup-open:bg-hover"
                  data-testid="composer-overflow-trigger"
                  title="More actions"
                >
                  <IconDots size={ICON.md} stroke={ICON_STROKE.md} />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner align="start" side="top" sideOffset={6}>
                    <Menu.Popup
                      className="origin-(--transform-origin) min-w-[184px] popup-chrome popup-motion p-1"
                      data-testid="composer-overflow-menu"
                    >
                      <GroupMenuItem
                        icon={<IconPlus size={ICON.sm} stroke={ICON_STROKE.sm} />}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Attach files
                      </GroupMenuItem>
                      {onOpenConnections ? (
                        <GroupMenuItem
                          icon={<IconPlugConnected size={ICON.sm} stroke={ICON_STROKE.sm} />}
                          onClick={onOpenConnections}
                        >
                          Connections
                        </GroupMenuItem>
                      ) : null}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            ) : (
              <button
                aria-label="Attach files"
                className="app-no-drag flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                onClick={() => fileInputRef.current?.click()}
                title="Attach files"
                type="button"
              >
                <IconPlus size={ICON.md} stroke={ICON_STROKE.md} />
              </button>
            )}
            <input
              accept="image/*"
              className="hidden"
              multiple
              onChange={(event) => {
                if (event.target.files?.length) {
                  void addFiles(event.target.files);
                }
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />

            {!isInlineEdit ? (
              <>
                <ModePill
                  mode={mode}
                  onCycle={() => setMode(cycleComposerMode(mode))}
                  onExit={() => setMode("build")}
                />
                {branchControl}
                {onOpenConnections && !toolbarOverflow ? (
                  <button
                    aria-label="Connections"
                    className="app-no-drag inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                    onClick={onOpenConnections}
                    title="Manage Connections and Composio access"
                    type="button"
                  >
                    <IconPlugConnected size={ICON.sm} stroke={ICON_STROKE.sm} />
                    {toolbarTier === "lg" ? <span>Connections</span> : null}
                  </button>
                ) : null}
              </>
            ) : null}

            <div className="flex-1" />

            {submitError ? (
              <span className="min-w-0 truncate text-2xs text-danger" title={submitError}>
                {submitError}
              </span>
            ) : null}

            {!isInlineEdit ? (
              <ContextUsageIndicator
                {...(currentModel?.contextWindow
                  ? { contextWindow: currentModel.contextWindow }
                  : {})}
                {...(contextUsage ? { usage: contextUsage } : {})}
              />
            ) : null}

            {trailingActions}

            {onCancel ? (
              <button
                aria-label="Cancel"
                className="flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                disabled={submitting}
                onClick={onCancel}
                type="button"
              >
                <IconX size={ICON.md} stroke={ICON_STROKE.md} />
              </button>
            ) : null}

            {/* One control: arrow → square morph while the agent is running. */}
            <button
              aria-label={isRunning ? "Stop" : "Send"}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-fg text-canvas transition-colors hover:bg-fg-muted active:scale-[0.94] disabled:bg-chip-strong disabled:text-fg-faint"
              disabled={isRunning ? !onAbort : !hasContent || !canSubmit || submitting || !model}
              onClick={() => {
                if (isRunning) onAbort?.();
                else send();
              }}
              type="button"
            >
              {submitting && !isRunning ? (
                <IconLoader2
                  className="animate-spin motion-reduce:animate-none"
                  size={ICON.sm}
                  stroke={ICON_STROKE.sm}
                />
              ) : (
                <SendStopIcon busy={isRunning} className="size-3.5" />
              )}
            </button>
          </div>
        </ComposerToolbarTierContext.Provider>
        {footer ? (
          <div className="relative z-10 border-t border-hairline-soft px-3 py-1.5">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

function ModePill({
  mode,
  onCycle,
  onExit,
}: {
  mode: AgentMode;
  onCycle: () => void;
  onExit: () => void;
}) {
  const label = mode === "spec" ? "Spec" : mode === "plan" ? "Plan" : "Build";
  const activePlanningMode = mode !== "build";
  return (
    <div className="app-no-drag inline-flex h-7 shrink-0 items-center gap-0.5">
      <button
        aria-label={`Change mode, currently ${label}`}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 transition-colors",
          activePlanningMode
            ? "border-accent/30 bg-accent/10 text-accent hover:bg-accent/15"
            : "border-hairline text-fg-muted hover:bg-hover hover:text-fg",
        )}
        onClick={onCycle}
        title={`${label} mode — click or press Shift+Tab to change mode`}
        type="button"
      >
        {activePlanningMode ? (
          <IconListCheck aria-hidden size={ICON.sm} stroke={ICON_STROKE.sm} />
        ) : (
          <IconSparkles aria-hidden size={ICON.sm} stroke={ICON_STROKE.sm} />
        )}
        <span className="font-medium text-xs">{label}</span>
        <IconChevronDown
          aria-hidden
          className="opacity-70"
          size={ICON.xs}
          stroke={ICON_STROKE.xs}
        />
      </button>
      {activePlanningMode ? (
        <button
          aria-label={`Exit ${label} mode`}
          className="flex size-6 items-center justify-center rounded-md text-accent/70 transition-colors hover:bg-accent/15 hover:text-accent"
          onClick={onExit}
          type="button"
        >
          <IconX aria-hidden size={ICON.xs} stroke={ICON_STROKE.xs} />
        </button>
      ) : null}
    </div>
  );
}

function ContextUsageIndicator({
  contextWindow,
  usage,
}: {
  contextWindow?: number;
  usage?: ContextUsageInfo;
}) {
  const percent = contextUsagePercent(usage);
  const label = percent === undefined ? "not available yet" : `${Math.round(percent)}%`;

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Context usage ${label}`}
        className="app-no-drag flex h-[26px] w-[26px] items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg data-popup-open:bg-hover data-popup-open:text-fg"
      >
        <ContextUsageRing percent={percent} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" side="top" sideOffset={8}>
          <Popover.Popup className="origin-(--transform-origin) popup-chrome p-2 transition-[transform,opacity] duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0">
            <ContextUsageTooltip
              {...(contextWindow ? { contextWindow } : {})}
              {...(usage ? { usage } : {})}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ContextUsageTooltip({
  contextWindow,
  usage,
}: {
  contextWindow?: number;
  usage?: ContextUsageInfo;
}) {
  const total = contextUsagePercent(usage);
  const usageWindow = usage?.contextWindow ?? contextWindow;
  const tokenLine =
    usage?.tokens !== null && usage?.tokens !== undefined && usageWindow
      ? `${usage.tokens.toLocaleString()} / ${usageWindow.toLocaleString()} tokens`
      : undefined;

  if (total === undefined && !tokenLine) {
    return (
      <div className="w-[260px] px-1 py-1.5 text-sm text-fg">
        <div className="mb-1 font-medium text-fg-muted">Context usage</div>
        <div className="text-fg-faint text-xs">No context usage yet.</div>
        {usageWindow ? (
          <div className="mt-2 text-2xs text-fg-faint">
            Context window {usageWindow.toLocaleString()} tokens
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="w-[320px] px-1 py-1.5 text-sm text-fg">
      <div className="mb-2 font-medium text-fg-muted">Context usage</div>
      <ContextUsageRow label="Total" strong value={formatUsagePercent(total)} />
      {tokenLine ? <div className="mt-2 text-xs text-fg-faint">{tokenLine}</div> : null}
    </div>
  );
}

function ContextUsageRow({
  label,
  strong = false,
  value,
}: {
  label: string;
  strong?: boolean;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-1">
      <span className={strong ? "font-semibold text-fg" : "text-fg-muted"}>{label}</span>
      <span className={strong ? "font-semibold text-fg" : "text-fg"}>{value}</span>
    </div>
  );
}
