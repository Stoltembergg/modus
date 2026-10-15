import {
  IconBook2,
  IconFile,
  IconFolder,
  IconGitBranch,
  IconLayoutList,
  IconMessage2,
  IconPencil,
  IconSearch,
  IconTerminal2,
  IconUser,
  IconWorld,
} from "@tabler/icons-react";
import { memo, useState } from "react";
import { agentAvatarForId } from "../../../../shared/agent-templates";
import type {
  AgentInfo,
  ContextItem,
  MessageContextChip,
  ModelInfo,
  PromptImageAttachment,
  SkillSelection,
} from "../../../../shared/contracts";
import { CopyButton } from "../../components/ui/CopyButton";
import { ImageThumb } from "../../components/ui/ImageViewer";
import { ModusBot } from "../../components/ui/ModusBot";
import { cn } from "../../lib/cn";
import { useClipFade } from "../../lib/useClipFade";
import { AgentAvatar } from "../agents/AgentAvatar";
import {
  COMPOSER_RADIUS_CLASS,
  Composer,
  type ComposerDraft,
  createEmptyComposerDraft,
} from "../composer/Composer";
import { InspectGlyph, SkillTokenContent } from "../composer/composerTokens";
import type { ComposerImage } from "../composer/useComposerImages";
import { materialIconForFile } from "../files/fileIcons";
import { PromptSources } from "../sources/PromptSources";
import type { RunSource } from "../sources/runSources";
import { CheckpointRestoreButton } from "./CheckpointRestoreButton";
import { MarkdownMessage } from "./MarkdownMessage";

type MessageBlockProps = {
  messageRole: "assistant" | "user";
  assistantAgent?: AgentInfo | undefined;
  assistantAgentId?: string | undefined;
  /** Timeline id of this message — the rollback anchor for edit & resend. */
  messageId: string;
  content: string;
  streaming?: boolean;
  /** User only: pre-run snapshot this message can roll the files back to. */
  checkpointId?: string;
  onRestoreCheckpoint?(checkpointId: string): Promise<void> | void;
  /** User only: this message anchors a rollback point and can be edited. */
  editable?: boolean;
  /** Rolls the session back to this message, then resends the edited text. */
  onEditResend?(
    messageId: string,
    message: string,
    attachments?: PromptImageAttachment[],
    contextItems?: ContextItem[],
    skills?: SkillSelection[],
  ): Promise<void>;
  /** Required to mount the shared Composer for inline edit-resend. */
  model?: string;
  models?: ModelInfo[];
  workspaceId?: string | undefined;
  cwd?: string | undefined;
  /** Open a workspace file in the Files inspector panel. */
  onOpenFile?: ((path: string) => void) | undefined;
  /** User only: images attached to the prompt, rendered as thumbnails. */
  attachments?: PromptImageAttachment[];
  /** User only: context chips attached to the prompt, kept visible after send. */
  contextChips?: MessageContextChip[];
  /** User only: original context items for edit-and-resend. */
  contextItems?: ContextItem[];
  /** User only: selected skills attached to the prompt. */
  skills?: SkillSelection[];
  /** Run-scoped references shown only after the final assistant response. */
  sources?: RunSource[];
  /** Completeness state of the run-scoped reference lookup. */
  sourceStatus?: "loading" | "unavailable";
  compactClip?: boolean | undefined;
};

export const MessageBlock = memo(function MessageBlock({
  messageRole,
  assistantAgent,
  assistantAgentId,
  messageId,
  content,
  streaming = false,
  checkpointId,
  onRestoreCheckpoint,
  editable = false,
  onEditResend,
  model = "",
  models = [],
  workspaceId,
  cwd,
  onOpenFile,
  attachments,
  contextChips,
  contextItems,
  skills,
  sources,
  sourceStatus,
  compactClip = false,
}: MessageBlockProps) {
  const [editing, setEditing] = useState(false);
  // Pause measurement while the edit composer owns the slot — remounting the
  // clip surface must re-run the observer (active flip), not reuse a stale one.
  const { boxRef, contentRef, clipped } = useClipFade(!editing && compactClip);

  if (messageRole === "user") {
    const hasAttachments = Boolean(attachments?.length);
    const hasText = content.trim().length > 0;
    const hasInlineTokens = Boolean(contextChips?.length || skills?.length);
    // File/folder chips are omitted from body text (chips + context[] are authority),
    // so chip-only prompts must still render a bubble.
    if (!hasText && !hasAttachments && !hasInlineTokens) return null;

    const canEdit = Boolean(editable && onEditResend && model && models.length > 0);
    const showEditor = Boolean(editing && canEdit && onEditResend);
    // Compact previews keep their sticky slot while editing. Main-chat cards
    // stay in normal flow so an unabridged long prompt cannot cover its response.
    const bubbleBody = (
      <>
        <PromptAttachmentRow {...(attachments ? { attachments } : {})} />
        {hasText || hasInlineTokens ? (
          <div className="whitespace-pre-wrap wrap-break-word">
            {contextChips
              ?.filter(
                (chip): chip is MessageContextChip => chip != null && typeof chip.kind === "string",
              )
              .map((chip) => (
                <InlineContextToken
                  chip={chip}
                  key={`${chip.kind}:${chip.label}:${chip.detail ?? ""}`}
                />
              ))}
            {(skills ?? []).map((skill) => (
              <InlineSkillToken key={skill.path} name={skill.name} />
            ))}
            {hasText ? content : null}
          </div>
        ) : null}
      </>
    );

    return (
      <div
        className={cn(
          "message-card-slot flex w-full min-w-0 items-start justify-end gap-2",
          compactClip && cn("sticky top-0 z-10 bg-elevated", COMPOSER_RADIUS_CLASS),
        )}
      >
        {showEditor && onEditResend ? (
          <InlineEditComposer
            {...(attachments ? { attachments } : {})}
            content={content}
            {...(contextChips ? { contextChips } : {})}
            {...(contextItems ? { contextItems } : {})}
            cwd={cwd}
            messageId={messageId}
            model={model}
            models={models}
            checkpointId={checkpointId}
            onCancel={() => setEditing(false)}
            onEditResend={onEditResend}
            onRestoreCheckpoint={onRestoreCheckpoint}
            {...(skills ? { skills } : {})}
            workspaceId={workspaceId}
          />
        ) : (
          /* biome-ignore lint/a11y: The conditional control can contain nested image buttons. */
          <div
            aria-label={canEdit ? "Edit message" : undefined}
            className={cn(
              "chat-message-bubble chat-message-surface text-left text-sm text-fg leading-relaxed",
              canEdit && "cursor-pointer",
            )}
            data-message-role="user"
            onClick={canEdit ? () => setEditing(true) : undefined}
            onKeyDown={
              canEdit
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setEditing(true);
                    }
                  }
                : undefined
            }
            role={canEdit ? "button" : undefined}
            tabIndex={canEdit ? 0 : undefined}
          >
            {/* Only compact previews clip: the main chat retains every line. */}
            <div
              className={cn(
                compactClip && "max-h-[5.6875em] overflow-hidden",
                compactClip && clipped && "clip-fade",
              )}
              ref={boxRef}
            >
              <div className="space-y-2" ref={contentRef}>
                {bubbleBody}
              </div>
            </div>
          </div>
        )}
        {!showEditor ? (
          <span
            aria-label="You"
            role="img"
            className="mt-2 flex size-[24px] shrink-0 items-center justify-center text-fg-subtle"
          >
            <IconUser aria-hidden size={20} stroke={1.5} />
          </span>
        ) : null}
      </div>
    );
  }

  if (!content && (streaming || (!sources?.length && !sourceStatus))) return null;

  return (
    <div className="flex w-full min-w-0 items-start gap-2" data-message-row="assistant">
      <AssistantAvatar agent={assistantAgent} agentId={assistantAgentId} streaming={streaming} />
      <div
        className="chat-message-bubble chat-message-surface text-xs leading-relaxed"
        data-message-role="assistant"
      >
        {content ? (
          <MarkdownMessage
            content={content}
            cwd={cwd}
            onOpenFile={onOpenFile}
            streaming={streaming}
          />
        ) : null}
        {!streaming && sources?.length ? (
          <PromptSources onOpenFile={onOpenFile} sources={sources} />
        ) : null}
        {!streaming && sourceStatus === "loading" ? (
          <div className="mt-2 text-xs text-muted" role="status">
            Loading run sources…
          </div>
        ) : null}
        {!streaming && sourceStatus === "unavailable" ? (
          <div className="mt-2 text-xs text-muted" role="status">
            Run sources could not be loaded. Tool activity remains in the timeline.
          </div>
        ) : null}
      </div>
    </div>
  );
});

function AssistantAvatar({
  agent,
  agentId,
  streaming,
}: {
  agent?: AgentInfo | undefined;
  agentId?: string | undefined;
  streaming: boolean;
}) {
  const id = agentId ?? agent?.id;
  if (!id) {
    return (
      <span className="mt-2 size-[24px] shrink-0">
        <ModusBot active={false} className="size-[24px]" motionScale={0.25} />
      </span>
    );
  }
  const profile = agent?.id === id ? agent : undefined;
  const avatar = profile ?? agentAvatarForId(id);
  return (
    <AgentAvatar
      className="mt-2"
      color={avatar.avatarColor}
      face={avatar.avatarFace}
      label={profile?.name || "Agent"}
      seed={id}
      shape={avatar.avatarShape}
      size={24}
      state={profile?.archivedAt ? "archived" : streaming ? "working" : "idle"}
    />
  );
}

/** Seeds the shared Composer for edit-resend — no parallel editor UI. */
function InlineEditComposer({
  messageId,
  content,
  attachments,
  contextChips,
  contextItems,
  skills,
  model,
  models,
  cwd,
  workspaceId,
  checkpointId,
  onCancel,
  onEditResend,
  onRestoreCheckpoint,
}: {
  messageId: string;
  content: string;
  attachments?: PromptImageAttachment[];
  contextChips?: MessageContextChip[];
  contextItems?: ContextItem[];
  skills?: SkillSelection[];
  model: string;
  models: ModelInfo[];
  cwd: string | undefined;
  workspaceId: string | undefined;
  checkpointId: string | undefined;
  onCancel(): void;
  onEditResend(
    messageId: string,
    message: string,
    attachments?: PromptImageAttachment[],
    contextItems?: ContextItem[],
    skills?: SkillSelection[],
  ): Promise<void>;
  onRestoreCheckpoint: ((checkpointId: string) => Promise<void> | void) | undefined;
}) {
  const [draft, setDraft] = useState<ComposerDraft>(() => ({
    ...createEmptyComposerDraft(),
    value: content,
    images: attachmentsToComposerImages(attachments),
    selectedSkills: skills ?? [],
  }));
  const [editContextItems, setEditContextItems] = useState<ContextItem[]>(
    () => contextItems ?? contextItemsFromChips(contextChips ?? [], workspaceId),
  );

  return (
    <Composer
      trailingActions={
        <>
          <CopyButton label="Copy message" text={draft.value} />
          {checkpointId && onRestoreCheckpoint ? (
            <CheckpointRestoreButton checkpointId={checkpointId} onRestore={onRestoreCheckpoint} />
          ) : null}
        </>
      }
      canSubmit={Boolean(model)}
      contextItems={editContextItems}
      cwd={cwd}
      draft={draft}
      model={model}
      models={models}
      onCancel={onCancel}
      onContextChange={setEditContextItems}
      onDraftChange={setDraft}
      onSubmit={(message, nextContext, _delivery, nextAttachments, nextSkills) =>
        onEditResend(messageId, message, nextAttachments, nextContext, nextSkills)
      }
      workspaceId={workspaceId}
    />
  );
}

function attachmentsToComposerImages(
  attachments: PromptImageAttachment[] | undefined,
): ComposerImage[] {
  if (!attachments?.length) {
    return [];
  }
  return attachments.map((attachment, index) => ({
    id: `edit-att-${index}-${attachment.name ?? "image"}`,
    name: attachment.name ?? `image-${index + 1}`,
    mimeType: attachment.mimeType,
    dataUrl: `data:${attachment.mimeType};base64,${attachment.data}`,
  }));
}

/** Shared prompt image strip — same size/fit as Composer draft thumbnails. */
function PromptAttachmentRow({
  attachments,
  className,
}: {
  attachments?: PromptImageAttachment[];
  className?: string;
}) {
  if (!attachments?.length) {
    return null;
  }
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {attachments.map((attachment, index) => (
        <ImageThumb
          alt={attachment.name ?? `attachment ${index + 1}`}
          className="size-14 rounded-lg border border-hairline bg-canvas object-contain"
          key={`${attachment.name ?? "image"}:${attachment.data.length}:${attachment.data.slice(-24)}`}
          src={`data:${attachment.mimeType};base64,${attachment.data}`}
          title={attachment.name}
        />
      ))}
    </div>
  );
}

function contextItemsFromChips(
  chips: MessageContextChip[],
  workspaceId: string | undefined,
): ContextItem[] {
  return chips.flatMap((chip): ContextItem[] => {
    if (chip == null || typeof chip.kind !== "string") {
      return [];
    }
    if (chip.kind === "git-diff") {
      return [{ type: "git-diff", mode: chip.label === "Branch" ? "branch" : "working-state" }];
    }
    if (chip.kind === "browser") {
      return [{ type: "browser", ...(workspaceId ? { workspaceId } : {}) }];
    }
    if (chip.kind === "project-summary") {
      return [{ type: "project-summary" }];
    }
    if (chip.kind === "recent-changes") {
      return [{ type: "recent-changes" }];
    }
    if (chip.kind === "rules") {
      return [{ type: "rules" }];
    }
    if (chip.kind === "search" && chip.label.startsWith("search:")) {
      return [{ type: "search", query: chip.label.slice("search:".length) }];
    }
    return [];
  });
}

function InlineContextToken({ chip }: { chip: MessageContextChip }) {
  const fileIcon =
    chip.kind === "file" || chip.kind === "excerpt" ? materialIconForFile(chip.label) : undefined;
  return (
    <span
      className="mr-1 inline-flex max-w-[260px] items-center gap-1 align-[-0.15em] font-medium text-link text-sm"
      style={chip.color ? { color: chip.color } : undefined}
      title={chip.detail ? `${chip.label} — ${chip.detail}` : chip.label}
    >
      {chip.kind === "design-element" ? (
        <InspectGlyph size={12} />
      ) : fileIcon ? (
        <img alt="" className="size-3 shrink-0" draggable={false} src={fileIcon} />
      ) : (
        <ContextKindIcon kind={chip.kind} />
      )}
      <span className="truncate">{chip.label}</span>
      {chip.detail ? (
        <span className="shrink-0 font-normal text-fg-muted">{chip.detail}</span>
      ) : null}
    </span>
  );
}

function InlineSkillToken({ name }: { name: string }) {
  return (
    <span className="mr-1 inline-flex font-medium text-sm" title={name}>
      <SkillTokenContent skill={{ name, path: name }} />
    </span>
  );
}

/** Muted leading icon for non-design context kinds. */
function ContextKindIcon({ kind }: { kind: MessageContextChip["kind"] }) {
  const props = { className: "size-3 shrink-0", stroke: 1.8 } as const;
  switch (kind) {
    case "folder":
      return <IconFolder {...props} />;
    case "doc":
    case "rules":
      return <IconBook2 {...props} />;
    case "terminal":
      return <IconTerminal2 {...props} />;
    case "browser":
      return <IconWorld {...props} />;
    case "past-chat":
      return <IconMessage2 {...props} />;
    case "git-diff":
    case "recent-changes":
      return <IconGitBranch {...props} />;
    case "project-summary":
      return <IconLayoutList {...props} />;
    case "search":
      return <IconSearch {...props} />;
    case "design-annotation":
      return <IconPencil {...props} />;
    default:
      return <IconFile {...props} />;
  }
}
