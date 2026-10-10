import { IconArrowDown } from "@tabler/icons-react";
import { m } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AgentEventPage } from "../../../../shared/agent-events";
import type {
  AgentMode,
  AgentSessionInfo,
  BrowserEvent,
  ContextItem,
  ContextUsageInfo,
  HyperPlanRevision,
  ModelInfo,
  ModusModelsStatus,
  PermissionDecision,
  PermissionRequest,
  PlanRef,
  PromptDelivery,
  PromptImageAttachment,
  QuestionAnswer,
  SkillSelection,
  SubagentActivity,
  SubagentStatus,
  WorkingChangeStats,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../shared/contracts";
import { VortexMark } from "../../components/ui/VortexMark";
import { lookupModel } from "../../lib/modelIdentity";
import {
  Composer,
  type ComposerDraft,
  type ComposerDraftUpdate,
  createEmptyComposerDraft,
  messageFromParts,
} from "../composer/Composer";
import { ComposerDock } from "../composer/ComposerDock";
import { contextItemKey } from "../composer/composerTokens";
import type { MentionEditorPart } from "../composer/MentionEditor";
import { SessionBranchPicker } from "../git/SessionBranchPicker";
import { buildPlanMessage, effectiveBuildStatus, normalizePlan } from "../plan/planState";
import { QuestionsCard } from "../plan/QuestionsCard";
import { ReviewPlanCard } from "../plan/ReviewPlanCard";
import { RunningProcessBar } from "../process/RunningProcessBar";
import { useManagedProcesses } from "../process/useManagedProcesses";
import { ProviderLogo } from "../settings/ProviderLogo";
import { useRunSourcesForRuns } from "../sources/useRunSources";
import { ApprovalPanel } from "./ApprovalPanel";
import {
  type AgentEventHub,
  type AgentEventItem,
  appendAgentEvents,
  appendUniqueAgentEvents,
  foldAgentEvents,
  optimisticUserPromptEvents,
  prependAgentEventPage,
} from "./agentEventHub";
import { ConversationTimeline } from "./ConversationTimeline";
import { ChangesStrip } from "./changes/ChangesStrip";
import { ModusUnavailableNotice } from "./ModusUnavailableNotice";
import { latestPendingPermissionRequest } from "./permissionRequests";
import { latestPendingQuestionRequest } from "./questionRequests";
import { RetryStatusBar } from "./RetryStatusBar";
import { latestSessionStatus } from "./runState";
import { SubagentPreviewSheet } from "./SubagentPreviewSheet";
import { readSessionScroll, rememberSessionScroll } from "./sessionScrollMemory";
import {
  isSubagentSessionLive,
  isSubagentSessionWorking,
  subagentActivityLabel,
} from "./subagentUi";
import { buildVisibleTimelineBlocks, Timeline } from "./Timeline";
import { splitTimelinePresentation } from "./timelinePresentation";
import { useAutoScroll } from "./useAutoScroll";
import { WorkingSubagentBar } from "./WorkingSubagentBar";

/**
 * Full conversation surface bound to one active session.
 */

/**
 * Keep the exact saved session identity; only sessions without one use the app default.
 */
export function turnModelForPane(defaultModel: string, sessionModel?: string | undefined): string {
  return sessionModel || defaultModel;
}

export function canSubmitPromptForSession(
  workspace: WorkspaceInfo | null,
  sessionWorkspaceId: string,
  modelId: string | undefined,
): boolean {
  return Boolean(modelId) && (Boolean(workspace) || sessionWorkspaceId === CHATS_WORKSPACE_ID);
}

type HyperPlanPreview = { draftId: string; revision: HyperPlanRevision };
type ChatEventHistoryPageState = {
  snapshotCursor?: number;
  beforeCursor?: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  error?: boolean | undefined;
};
const EMPTY_CHAT_EVENT_HISTORY_PAGE: ChatEventHistoryPageState = {
  hasOlder: false,
  loadingOlder: false,
};
type HyperPlanChoice = "revision" | "original";
type HyperPlanAgentApi = Pick<
  Window["modus"]["agent"],
  "createHyperPlanDraft" | "resolveHyperPlanDraft" | "startPlanBuild" | "startOriginalPlanBuild"
>;

type HyperPlanOperationError = Error & { stage: "choice" | "start" | "pending" };

/** Keeps idempotency identities and selection tokens private to this renderer instance. */
export function createHyperPlanOperations(
  api: HyperPlanAgentApi,
  createRequestId: () => string = () => crypto.randomUUID(),
) {
  const choices = new Map<
    string,
    {
      choiceRequestId: string;
      startRequestId: string;
      selectionId?: string;
      running: boolean;
      done: boolean;
    }
  >();
  const originals = new Map<
    string,
    {
      requestId: string;
      sourceSnapshot: HyperPlanSourceSnapshot;
      running: boolean;
      done: boolean;
    }
  >();

  return {
    review(input: { sessionId: string; planId: string; model?: string }) {
      return api.createHyperPlanDraft(input);
    },
    async choose(preview: HyperPlanPreview, choice: HyperPlanChoice) {
      const key = `${preview.draftId}:${choice}`;
      let operation = choices.get(key);
      if (!operation) {
        operation = {
          choiceRequestId: createRequestId(),
          startRequestId: createRequestId(),
          running: false,
          done: false,
        };
        choices.set(key, operation);
      }
      if (operation.running) throw operationError("pending");
      if (operation.done) return;
      operation.running = true;
      try {
        if (!operation.selectionId) {
          try {
            const selection = await api.resolveHyperPlanDraft({
              draftId: preview.draftId,
              choice,
              requestId: operation.choiceRequestId,
            });
            operation.selectionId = selection.selectionId;
          } catch {
            throw operationError("choice");
          }
        }
        try {
          await api.startPlanBuild({
            selectionId: operation.selectionId,
            requestId: operation.startRequestId,
          });
          operation.done = true;
        } catch {
          throw operationError("start");
        }
      } finally {
        operation.running = false;
      }
    },
    async buildOriginal(input: {
      sessionId: string;
      planId: string;
      sourceSnapshot: HyperPlanSourceSnapshot;
    }) {
      const key = `${input.sessionId}:${input.planId}`;
      let operation = originals.get(key);
      if (!operation) {
        operation = {
          requestId: createRequestId(),
          sourceSnapshot: input.sourceSnapshot,
          running: false,
          done: false,
        };
        originals.set(key, operation);
      }
      if (operation.running) throw operationError("pending");
      if (operation.done) return;
      operation.running = true;
      try {
        try {
          await api.startOriginalPlanBuild({
            sessionId: input.sessionId,
            planId: input.planId,
            sourceSnapshot: operation.sourceSnapshot,
            requestId: operation.requestId,
          });
          operation.done = true;
        } catch {
          throw operationError("start");
        }
      } finally {
        operation.running = false;
      }
    },
    reset() {
      choices.clear();
      originals.clear();
    },
  };
}

function operationError(stage: HyperPlanOperationError["stage"]): HyperPlanOperationError {
  return Object.assign(new Error("HyperPlan operation failed"), { stage });
}

const GENERIC_HYPERPLAN_REVIEW_ERROR =
  "HyperPlan review is unavailable. Try again or build the original plan.";

/**
 * Accept only short, path-free messages from main. Raw IPC noise falls back to the generic copy.
 */
export function safeHyperPlanReviewReason(error: unknown): string {
  if (!(error instanceof Error)) return GENERIC_HYPERPLAN_REVIEW_ERROR;
  const message = error.message.replace(/[\r\n\t]+/g, " ").trim();
  if (
    !message ||
    message.length > 200 ||
    /[\\/]/.test(message) ||
    /(?:^|[\s])(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var|etc|private)\b)/.test(message) ||
    /token|secret|password|api[_-]?key|authorization/i.test(message)
  ) {
    return GENERIC_HYPERPLAN_REVIEW_ERROR;
  }
  return message;
}

type HyperPlanSourceSnapshot = ReturnType<typeof hyperPlanSourceProjection>;

type HyperPlanReviewState =
  | { planId: string; planHash: string; sourceSnapshot: HyperPlanSourceSnapshot; status: "loading" }
  | {
      planId: string;
      planHash: string;
      sourceSnapshot: HyperPlanSourceSnapshot;
      status: "ready";
      preview: HyperPlanPreview;
    }
  | {
      planId: string;
      planHash: string;
      sourceSnapshot: HyperPlanSourceSnapshot;
      status: "review-error";
      /** Safe, user-facing failure reason from main (no secrets/paths). */
      reason?: string;
      originalStart?: "pending" | "error";
    }
  | {
      planId: string;
      planHash: string;
      sourceSnapshot: HyperPlanSourceSnapshot;
      status: "choosing" | "choice-error" | "start-error";
      preview: HyperPlanPreview;
      choice: HyperPlanChoice;
    };

export function reconcileHyperPlanReview(
  review: HyperPlanReviewState | undefined,
  latestPlan: PlanRef | undefined,
): { review: HyperPlanReviewState | undefined; invalidate: boolean } {
  if (!latestPlan || !review) {
    return { review, invalidate: false };
  }

  if (review.planId !== latestPlan.id) return { review: undefined, invalidate: true };

  const latestSource = hyperPlanSourceProjection(latestPlan);
  if (JSON.stringify(review.sourceSnapshot) === JSON.stringify(latestSource)) {
    return {
      review:
        review.planHash === latestPlan.hash ? review : { ...review, planHash: latestPlan.hash },
      invalidate: false,
    };
  }

  // Accept only the exact source projection written when promoting the
  // currently selected revision after a possibly-uncertain revision choice.
  if (
    (review.status === "choosing" ||
      review.status === "choice-error" ||
      review.status === "start-error") &&
    review.choice === "revision" &&
    matchesPromotedHyperPlanRevision(latestPlan, review.preview.revision)
  ) {
    return {
      review: { ...review, planHash: latestPlan.hash, sourceSnapshot: latestSource },
      invalidate: false,
    };
  }

  return { review: undefined, invalidate: true };
}

export function hyperPlanSourceProjection(plan: PlanRef) {
  return {
    title: plan.title,
    overview: plan.overview,
    content: plan.content,
    todos: plan.todos.map(({ id, content, acceptanceCriterionIds }) => ({
      id,
      content,
      acceptanceCriterionIds: acceptanceCriterionIds ?? [],
    })),
    spec: plan.spec && {
      requirements: plan.spec.requirements,
      acceptanceCriteria: plan.spec.acceptanceCriteria,
      assumptions: plan.spec.assumptions,
      openQuestions: plan.spec.openQuestions,
      evidence: plan.spec.evidence ?? [],
    },
  };
}

function matchesPromotedHyperPlanRevision(plan: PlanRef, revision: HyperPlanRevision): boolean {
  if (!plan.spec) return false;
  if (
    plan.content !== revision.content.trim() ||
    plan.todos.some((todo) => todo.status !== "pending") ||
    plan.spec.acceptanceCriteria.some((criterion) => criterion.status !== "pending") ||
    plan.spec.evidence === undefined ||
    plan.spec.evidence.length !== 0
  )
    return false;

  const revisionSource = {
    title: revision.title,
    overview: revision.overview,
    content: revision.content.trim(),
    todos: revision.todos.map(({ id, content, acceptanceCriterionIds }) => ({
      id,
      content,
      acceptanceCriterionIds: acceptanceCriterionIds ?? [],
    })),
    spec: {
      requirements: revision.spec.requirements,
      acceptanceCriteria: revision.spec.acceptanceCriteria,
      assumptions: revision.spec.assumptions,
      openQuestions: revision.spec.openQuestions,
    },
  };
  const planSource = {
    title: plan.title,
    overview: plan.overview,
    content: plan.content,
    todos: plan.todos.map(({ id, content, acceptanceCriterionIds }) => ({
      id,
      content,
      acceptanceCriterionIds: acceptanceCriterionIds ?? [],
    })),
    spec: {
      requirements: plan.spec.requirements,
      acceptanceCriteria: plan.spec.acceptanceCriteria.map(
        ({ status: _status, ...criterion }) => criterion,
      ),
      assumptions: plan.spec.assumptions,
      openQuestions: plan.spec.openQuestions,
    },
  };
  return JSON.stringify(planSource) === JSON.stringify(revisionSource);
}

type ChatPaneProps = {
  session: AgentSessionInfo;
  hub: AgentEventHub;
  models: ModelInfo[];
  /** App-level default model id — fallback when the session has none. */
  defaultModel: string;
  /** L3b0: Modus provider state (ModelSettingsState.modus) for the inline unavailable notice. */
  modusStatus?: ModusModelsStatus | undefined;
  contextUsage?: ContextUsageInfo | undefined;
  workspace: WorkspaceInfo | null;
  initialEvents?: AgentEventItem[] | undefined;
  onInitialEventsConsumed?(sessionId: string): void;
  /** Refresh the session list after operations that mutate session rows. */
  onSessionsChanged(): void;
  onModelChange(model: string): void;
  onModelConfigChange(model: string, thinkingVariant: string): Promise<void> | void;
  /** "Review" on the changes strip: focus this pane and open the diff panel. */
  onOpenReview(cwd?: string): void;
  /** Open the technical event history without adding it to the transcript. */
  onOpenActivity?(): void;
  /** Open the first-class Connections destination from the Composer. */
  onOpenConnections?(): void;
  onOpenSubagent?(childSessionId: string): void;
  composerReplacement?: ReactNode;
  composerDraft?: ChatComposerDraft | undefined;
  onComposerDraftChange?(update: ChatComposerDraftUpdate): void;
  /** A plan was (re)written in Plan Mode: keep the inspector's plan data current. */
  onPlanUpdated(plan: PlanRef): void;
  /** Explicitly open a completed timeline plan in the inspector. */
  onOpenPlan?(plan: PlanRef): void;
  /** Open a workspace file in the Files inspector panel. */
  onOpenFile?(path: string, line?: number): void;
  /** Open a background terminal in the Terminal inspector panel. */
  onOpenTerminal?(terminalId: string): void;
  /**
   * Child sessions of this pane's session. When set with `onOpenSubagent`,
   * timeline/rail clicks open a local preview; `onOpenSubagent` is Expand only.
   */
  subagentSessions?: AgentSessionInfo[] | undefined;
  /** Omit composer dock — used by the local subagent preview sheet. */
  hideComposer?: boolean | undefined;
  /**
   * Preview / inspector chrome only: hide the turn rail and use embedded
   * timeline padding. Streaming physics stay identical to the main pane.
   * Defaults to true when `hideComposer` is set.
   */
  lite?: boolean | undefined;
  /**
   * Session already mounted live in the inspector detail pane. Authority for
   * "at most one live ChatPane per sessionId" — preview must not dual-mount.
   */
  inspectorLiveSessionId?: string | undefined;
};

type DesignContextItem = Extract<ContextItem, { type: "design-element" }>;
type DesignAnnotationContextItem = Extract<ContextItem, { type: "design-annotation" }>;

export type ChatComposerDraft = ComposerDraft & {
  contextItems: ContextItem[];
  mode: AgentMode;
};

export type ChatComposerDraftUpdate =
  | ChatComposerDraft
  | ((current: ChatComposerDraft) => ChatComposerDraft);

export function createEmptyChatComposerDraft(): ChatComposerDraft {
  return { ...createEmptyComposerDraft(), contextItems: [], mode: "build" };
}

function resolveDraftUpdate<T>(update: T | ((current: T) => T), current: T): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

export function addContextItemToDraft(
  draft: ChatComposerDraft,
  item: ContextItem,
): ChatComposerDraft {
  const key = contextItemKey(item);
  if (draft.contextItems.some((contextItem) => contextItemKey(contextItem) === key)) {
    return draft;
  }
  return {
    ...draft,
    contextItems: [...draft.contextItems, item],
    parts: [
      ...(draft.parts ?? [
        ...draft.contextItems.map((contextItem) => ({
          type: "context" as const,
          item: contextItem,
        })),
        ...(draft.value ? [{ type: "text" as const, text: `${draft.value}\n` }] : []),
      ]),
      { type: "context" as const, item },
    ],
  };
}

export function addDesignElementToDraft(
  draft: ChatComposerDraft,
  event: Extract<BrowserEvent, { type: "browser.design-select" }>,
): ChatComposerDraft {
  const sourceElements = event.element.elements ?? [event.element];
  const referencedIndices = event.element.contentParts
    ? Array.from(
        new Set(
          event.element.contentParts
            .filter((part) => part.type === "element")
            .map((part) => part.index),
        ),
      ).filter((index) => sourceElements[index])
    : sourceElements.map((_, index) => index);
  const designItems: DesignContextItem[] =
    event.element.elements && event.element.elements.length > 0
      ? referencedIndices.flatMap((sourceIndex, index): DesignContextItem[] => {
          const part = sourceElements[sourceIndex];
          if (!part) {
            return [];
          }
          return [
            {
              type: "design-element",
              element: {
                ...part,
                id: `${event.element.id}:${sourceIndex}`,
                tabId: event.element.tabId,
                url: event.element.url,
                ...(index === 0 && referencedIndices.length > 1
                  ? {
                      elements: referencedIndices.flatMap((itemIndex) => {
                        const item = sourceElements[itemIndex];
                        return item ? [item] : [];
                      }),
                    }
                  : {}),
                ...(index === 0 && event.element.screenshotDataUrl
                  ? { screenshotDataUrl: event.element.screenshotDataUrl }
                  : {}),
              },
            },
          ];
        })
      : referencedIndices.length > 0
        ? [{ type: "design-element", element: event.element }]
        : [];
  const existingIds = new Set(
    draft.contextItems
      .filter((item) => item.type === "design-element")
      .map((item) => item.element.id),
  );
  const nextContextItems = [
    ...draft.contextItems,
    ...designItems.filter((item) => !existingIds.has(item.element.id)),
  ];
  const nextImages =
    event.element.screenshotDataUrl && !draft.images.some((image) => image.id === event.element.id)
      ? [
          ...draft.images,
          {
            id: event.element.id,
            name: `${event.element.label}.png`,
            mimeType: "image/png",
            dataUrl: event.element.screenshotDataUrl,
          },
        ]
      : draft.images;
  const text = event.seedText?.trim();
  const insertedItems = designItems.filter((item) => !existingIds.has(item.element.id));
  const nextValue = text
    ? draft.value.trim()
      ? `${draft.value.trimEnd()}\n${text}`
      : text
    : draft.value;
  const designParts: MentionEditorPart[] | undefined = event.element.contentParts?.flatMap(
    (part): MentionEditorPart[] => {
      if (part.type === "text") {
        return part.text ? [{ type: "text", text: part.text }] : [];
      }
      const singleId = part.index === 0 ? event.element.id : undefined;
      const multiId = `${event.element.id}:${part.index}`;
      const item =
        insertedItems.find(
          (candidate) => candidate.element.id === multiId || candidate.element.id === singleId,
        ) ??
        designItems.find(
          (candidate) => candidate.element.id === multiId || candidate.element.id === singleId,
        ) ??
        (part.index === 0 ? (insertedItems[0] ?? designItems[0]) : undefined);
      return item ? [{ type: "context", item }] : [];
    },
  );
  const nextParts =
    designParts && designParts.length > 0
      ? [
          ...(draft.parts ?? [
            ...draft.contextItems.map((item) => ({ type: "context" as const, item })),
            ...(draft.value ? [{ type: "text" as const, text: `${draft.value}\n` }] : []),
          ]),
          ...designParts,
        ]
      : draft.parts;
  return {
    ...draft,
    contextItems: nextContextItems,
    images: nextImages,
    parts: nextParts,
    value: nextValue,
  };
}

export function addDesignAnnotationToDraft(
  draft: ChatComposerDraft,
  event: Extract<BrowserEvent, { type: "browser.design-annotate" }>,
): ChatComposerDraft {
  const item: DesignAnnotationContextItem = {
    type: "design-annotation",
    annotation: event.annotation,
  };
  const exists = draft.contextItems.some(
    (contextItem) =>
      contextItem.type === "design-annotation" && contextItem.annotation.id === event.annotation.id,
  );
  const nextContextItems = exists ? draft.contextItems : [...draft.contextItems, item];
  const nextImages =
    event.annotation.screenshotDataUrl &&
    !draft.images.some((image) => image.id === event.annotation.id)
      ? [
          ...draft.images,
          {
            id: event.annotation.id,
            name: `${event.annotation.label}.png`,
            mimeType: "image/png",
            dataUrl: event.annotation.screenshotDataUrl,
          },
        ]
      : draft.images;
  const text = event.annotation.seedText?.trim();
  const nextValue = text
    ? draft.value.trim()
      ? `${draft.value.trimEnd()}\n${text}`
      : text
    : draft.value;
  const nextParts = exists
    ? draft.parts
    : [
        ...(draft.parts ?? [
          ...draft.contextItems.map((contextItem) => ({
            type: "context" as const,
            item: contextItem,
          })),
          ...(draft.value ? [{ type: "text" as const, text: `${draft.value}\n` }] : []),
        ]),
        { type: "context" as const, item },
        ...(text ? [{ type: "text" as const, text }] : []),
      ];
  return {
    ...draft,
    contextItems: nextContextItems,
    images: nextImages,
    parts: nextParts,
    value: nextValue,
  };
}

export function designEventToPromptInput(
  event: Extract<BrowserEvent, { type: "browser.design-select" | "browser.design-annotate" }>,
): {
  message: string;
  context: ContextItem[];
  attachments?: PromptImageAttachment[] | undefined;
  mode: AgentMode;
} {
  const draft =
    event.type === "browser.design-select"
      ? addDesignElementToDraft(createEmptyChatComposerDraft(), event)
      : addDesignAnnotationToDraft(createEmptyChatComposerDraft(), event);
  const hasInlineText = draft.parts?.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  );
  const message =
    draft.value.trim() || hasInlineText
      ? messageFromParts(draft.parts, draft.value.trim())
      : draft.images.length > 0
        ? "See the selected design context."
        : "Use the selected design context.";
  const attachments = draft.images.map((image) => ({
    type: "image" as const,
    data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1),
    mimeType: image.mimeType,
    name: image.name,
  }));
  return {
    message,
    context: draft.contextItems,
    ...(attachments.length > 0 ? { attachments } : {}),
    mode: draft.mode,
  };
}

export function ChatPane({
  session,
  hub,
  models,
  defaultModel,
  modusStatus,
  contextUsage,
  workspace,
  initialEvents,
  onInitialEventsConsumed,
  onSessionsChanged,
  onModelChange,
  onModelConfigChange,
  onOpenReview,
  onOpenActivity,
  onOpenConnections,
  onOpenSubagent,
  composerReplacement,
  composerDraft,
  onComposerDraftChange,
  onPlanUpdated,
  onOpenPlan,
  onOpenFile,
  onOpenTerminal,
  subagentSessions,
  hideComposer = false,
  lite,
  inspectorLiveSessionId,
}: ChatPaneProps) {
  const isLite = lite ?? hideComposer;
  const sessionId = session.id;
  const [agentEvents, setAgentEvents] = useState<AgentEventItem[]>([]);
  const [eventSummaryEvents, setEventSummaryEvents] = useState<AgentEventItem[]>([]);
  const [eventHistoryPage, setEventHistoryPage] = useState(EMPTY_CHAT_EVENT_HISTORY_PAGE);
  const eventHistoryPageRef = useRef(eventHistoryPage);
  const eventHistoryGenerationRef = useRef(0);
  const [prependRevision, setPrependRevision] = useState(0);
  const updateEventHistoryPage = useCallback((state: ChatEventHistoryPageState): void => {
    eventHistoryPageRef.current = state;
    setEventHistoryPage(state);
  }, []);
  const [localComposerDraft, setLocalComposerDraft] = useState<ChatComposerDraft>(
    createEmptyChatComposerDraft,
  );
  const [promptError, setPromptError] = useState<string | undefined>();
  // L2: the session's saved branch no longer exists -> sending is blocked until replaced.
  const [branchBlocked, setBranchBlocked] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [workingStats, setWorkingStats] = useState<WorkingChangeStats | undefined>();
  const [dismissedPlanHash, setDismissedPlanHash] = useState<string | undefined>(undefined);
  const [hyperPlanReview, setHyperPlanReview] = useState<HyperPlanReviewState>();
  const hyperPlanRequestId = useRef(0);
  const hyperPlanOperations = useRef(createHyperPlanOperations(window.modus.agent));
  const [previewSubagentId, setPreviewSubagentId] = useState<string | undefined>();
  const managedProcesses = useManagedProcesses({
    workspaceId: workspace?.id,
    sessionId,
    origin: "agent",
  });
  const runningProcesses = useMemo(
    () => managedProcesses.processes.filter((process) => process.status === "running"),
    [managedProcesses.processes],
  );
  const stateAgentEvents = useMemo(() => {
    const byId = new Map<string, AgentEventItem>();
    for (const item of [...eventSummaryEvents, ...agentEvents]) byId.set(item.id, item);
    return [...byId.values()].sort((left, right) => {
      const leftCursor = (left.event as { eventCursor?: number }).eventCursor;
      const rightCursor = (right.event as { eventCursor?: number }).eventCursor;
      return leftCursor !== undefined && rightCursor !== undefined ? leftCursor - rightCursor : 0;
    });
  }, [agentEvents, eventSummaryEvents]);
  const subagentActivityByChild = useMemo(() => {
    const map = new Map<string, { status: SubagentStatus; activity?: SubagentActivity }>();
    for (const item of stateAgentEvents) {
      const event = item.event;
      if (event.type === "subagent.started") {
        map.set(event.childSessionId, { status: "running" });
      } else if (event.type === "subagent.updated") {
        const previous = map.get(event.childSessionId);
        map.set(event.childSessionId, {
          status: event.status,
          ...(event.activity
            ? { activity: event.activity }
            : previous?.activity
              ? { activity: previous.activity }
              : {}),
        });
      }
    }
    return map;
  }, [stateAgentEvents]);
  const workingSubagents = useMemo(() => {
    if (!subagentSessions?.length) {
      return [];
    }
    return subagentSessions
      .filter((child) => isSubagentSessionWorking(child.status))
      .map((child) => {
        const live = subagentActivityByChild.get(child.id);
        const status: SubagentStatus =
          live?.status ?? (child.status === "blocked" ? "blocked" : "running");
        return {
          id: child.id,
          task: child.subagentTask ?? child.title,
          activityLabel: subagentActivityLabel(status, live?.activity),
        };
      });
  }, [subagentSessions, subagentActivityByChild]);
  const previewSession = subagentSessions?.find((child) => child.id === previewSubagentId);
  const canPreviewSubagents = Boolean(subagentSessions && onOpenSubagent);
  const showChangesRail = Boolean(workingStats && workingStats.fileCount > 0);
  const hasComposerRails =
    runningProcesses.length > 0 || workingSubagents.length > 0 || showChangesRail;
  const activeComposerDraft = composerDraft ?? localComposerDraft;
  const contextItems = activeComposerDraft.contextItems;
  const composerMode = activeComposerDraft.mode;
  const setComposerDraft = useCallback(
    (update: ChatComposerDraftUpdate): void => {
      if (onComposerDraftChange) {
        onComposerDraftChange(update);
      } else {
        setLocalComposerDraft(update);
      }
    },
    [onComposerDraftChange],
  );
  const setContextItems = useCallback(
    (update: ContextItem[] | ((current: ContextItem[]) => ContextItem[])): void => {
      setComposerDraft((draft) => ({
        ...draft,
        contextItems: resolveDraftUpdate(update, draft.contextItems),
      }));
    },
    [setComposerDraft],
  );
  const setComposerMode = useCallback(
    (mode: AgentMode): void => {
      setComposerDraft((draft) => ({ ...draft, mode }));
    },
    [setComposerDraft],
  );
  const setComposerFields = useCallback(
    (update: ComposerDraftUpdate): void => {
      setComposerDraft((draft) => ({
        ...draft,
        ...resolveDraftUpdate(update, {
          value: draft.value,
          images: draft.images,
          parts: draft.parts,
          selectedSkills: draft.selectedSkills,
        }),
      }));
    },
    [setComposerDraft],
  );
  const addDesignElement = useCallback(
    (event: Extract<BrowserEvent, { type: "browser.design-select" }>): void => {
      setComposerDraft((draft) => addDesignElementToDraft(draft, event));
    },
    [setComposerDraft],
  );
  const addDesignAnnotation = useCallback(
    (event: Extract<BrowserEvent, { type: "browser.design-annotate" }>): void => {
      setComposerDraft((draft) => addDesignAnnotationToDraft(draft, event));
    },
    [setComposerDraft],
  );

  const queuedRef = useRef<AgentEventItem[]>([]);
  /** Pending frame-clock flush handle (requestAnimationFrame id). */
  const flushFrameRef = useRef<number | undefined>(undefined);
  const statsTimerRef = useRef<number | undefined>(undefined);
  const statsCwdRef = useRef(session.cwd);
  statsCwdRef.current = session.cwd;

  // The session's authoritative run-status (busy/retry/idle), read from the
  // runtime's `session.status` events. The composer locks while the session is
  // working (anything but idle), so a transient error never unlocks input
  // mid-turn. `pendingPrompt` is the optimistic bridge until the first status.
  const sessionStatus = useMemo(() => latestSessionStatus(stateAgentEvents), [stateAgentEvents]);
  const isRunning = !aborting && (sessionStatus.type !== "idle" || pendingPrompt);
  // Authoritative: keep SDK hot only while a turn is live (DB status or stream).
  const keepRuntimeHotRef = useRef(false);
  keepRuntimeHotRef.current = isSubagentSessionWorking(session.status) || isRunning;

  // Stick-to-bottom follows the bottom only while the session is working; idle
  // viewing/scrolling never snaps back (opencode's createAutoScroll model).
  const autoScroll = useAutoScroll(isRunning);
  const autoScrollResumeRef = useRef(autoScroll.resume);
  autoScrollResumeRef.current = autoScroll.resume;
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const prependScrollAnchorRef = useRef<{ height: number; top: number } | undefined>(undefined);
  const setChatScrollRef = useCallback(
    (el: HTMLDivElement | null): void => {
      scrollContainerRef.current = el;
      setScrollContainer(el);
      autoScroll.scrollRef(el);
    },
    [autoScroll.scrollRef],
  );

  const seedEventPage = useCallback(
    (page: AgentEventPage, optimisticEvents: AgentEventItem[] = []): AgentEventItem[] => {
      const events = foldAgentEvents([...optimisticEvents, ...page.events]);
      setEventSummaryEvents(page.summaryEvents);
      updateEventHistoryPage({
        snapshotCursor: page.snapshotCursor,
        ...(page.nextCursor === undefined ? {} : { beforeCursor: page.nextCursor }),
        hasOlder: page.hasMore,
        loadingOlder: false,
      });
      hub.seedHistory(sessionId, events, page.snapshotCursor);
      return hub.getHistory(sessionId);
    },
    [hub, sessionId, updateEventHistoryPage],
  );

  const loadOlderEventPage = useCallback(
    async (force = false): Promise<void> => {
      const state = eventHistoryPageRef.current;
      const requestGeneration = eventHistoryGenerationRef.current;
      if (
        !state.hasOlder ||
        state.loadingOlder ||
        (state.error && !force) ||
        state.snapshotCursor === undefined
      ) {
        return;
      }
      updateEventHistoryPage({ ...state, loadingOlder: true, error: undefined });
      try {
        const page = await window.modus.agent.listEventPage(sessionId, {
          direction: "backward",
          ...(state.beforeCursor === undefined ? {} : { beforeCursor: state.beforeCursor }),
          snapshotCursor: state.snapshotCursor,
        });
        if (eventHistoryGenerationRef.current !== requestGeneration) return;
        const current = hub.getHistory(sessionId);
        const merged = prependAgentEventPage(current, page.events);
        const viewport = scrollContainerRef.current;
        if (viewport) {
          prependScrollAnchorRef.current = {
            height: viewport.scrollHeight,
            top: viewport.scrollTop,
          };
        }
        hub.seedHistory(sessionId, merged, page.snapshotCursor);
        setAgentEvents(hub.getHistory(sessionId));
        setPrependRevision((revision) => revision + 1);
        updateEventHistoryPage({
          snapshotCursor: page.snapshotCursor,
          ...(page.nextCursor === undefined ? {} : { beforeCursor: page.nextCursor }),
          hasOlder:
            page.hasMore && page.nextCursor !== undefined && page.nextCursor !== state.beforeCursor,
          loadingOlder: false,
        });
      } catch {
        if (eventHistoryGenerationRef.current === requestGeneration) {
          updateEventHistoryPage({
            ...eventHistoryPageRef.current,
            loadingOlder: false,
            error: true,
          });
        }
      }
    },
    [hub, sessionId, updateEventHistoryPage],
  );

  useLayoutEffect(() => {
    void prependRevision;
    const anchor = prependScrollAnchorRef.current;
    const viewport = scrollContainerRef.current;
    if (!anchor || !viewport) return;
    prependScrollAnchorRef.current = undefined;
    viewport.scrollTop = anchor.top + Math.max(0, viewport.scrollHeight - anchor.height);
  }, [prependRevision]);

  const handleChatScroll = useCallback((): void => {
    autoScroll.handleScroll();
    const el = scrollContainerRef.current;
    if (el) {
      rememberSessionScroll(sessionId, el.scrollTop);
      if (el.scrollTop < 40) void loadOlderEventPage();
    }
  }, [autoScroll, loadOlderEventPage, sessionId]);

  /** After events paint, restore the user's place or pin to the latest turn. */
  const settleSessionViewport = useCallback((savedTop: number | undefined): void => {
    const apply = (): void => {
      const el = scrollContainerRef.current;
      if (!el) {
        return;
      }
      if (savedTop !== undefined) {
        el.scrollTop = Math.min(savedTop, Math.max(0, el.scrollHeight - el.clientHeight));
        return;
      }
      autoScrollResumeRef.current();
    };
    // WorkStatusLine / WorkFold layout settles across a couple frames; without
    // retries an idle remount stays at scrollTop 0 (session start).
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(() => {
        apply();
        window.setTimeout(apply, 50);
        window.setTimeout(apply, 200);
      });
    });
  }, []);
  const sourceRunIds = useMemo(() => {
    const runIds = new Set<string>();
    for (const { event } of agentEvents) {
      if (
        (event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.blocked" ||
          event.type === "run.cancelled") &&
        typeof event.runId === "string"
      ) {
        runIds.add(event.runId);
      }
    }
    return [...runIds].sort();
  }, [agentEvents]);
  const completeRunSources = useRunSourcesForRuns(sessionId, sourceRunIds);
  const visibleBlocks = useMemo(
    () => buildVisibleTimelineBlocks(agentEvents, completeRunSources),
    [agentEvents, completeRunSources],
  );
  const transcriptBlocks = useMemo(
    () => splitTimelinePresentation(visibleBlocks).transcriptBlocks,
    [visibleBlocks],
  );

  // The latest plan written/updated in this session. Keep the inspector's data
  // current without opening it; only the timeline card's expand action opens it.
  const latestPlan = useMemo<PlanRef | undefined>(() => {
    let latest: PlanRef | undefined;
    for (const item of stateAgentEvents) {
      if (item.event.type === "plan.updated") {
        latest = item.event.plan;
      }
    }
    // Old sessions recorded plan.updated before todos/overview/buildStatus
    // existed; normalize so the Plan panel and Review card can trust the shape.
    return latest ? normalizePlan(latest) : undefined;
  }, [stateAgentEvents]);

  useEffect(() => {
    if (latestPlan) {
      onPlanUpdated(latestPlan);
    }
  }, [latestPlan, onPlanUpdated]);

  useEffect(() => {
    const reconciliation = reconcileHyperPlanReview(hyperPlanReview, latestPlan);
    if (!reconciliation.invalidate) {
      if (reconciliation.review !== hyperPlanReview) {
        setHyperPlanReview(reconciliation.review);
      }
      return;
    }
    hyperPlanRequestId.current += 1;
    hyperPlanOperations.current.reset();
    setHyperPlanReview(reconciliation.review);
  }, [latestPlan, hyperPlanReview]);

  useEffect(
    () => () => {
      hyperPlanRequestId.current += 1;
      hyperPlanOperations.current.reset();
    },
    [],
  );

  /**
   * Build Locally: the user's explicit authorization to execute the approved
   * plan. Sends a CONCISE build message — the plan title, its to-dos, and a
   * pointer to the full plan.md — not the whole plan pasted inline. The agent
   * reads the file for full detail. Passing the plan id binds this turn's run
   * lifecycle to the plan's build status (building → built/not_built).
   */
  function buildPlanLocally(plan: PlanRef): void {
    setComposerMode("build");
    submitPrompt(buildPlanMessage(plan), [], "normal", undefined, undefined, "build", plan.id);
  }

  /** Refresh the working-tree change summary shown above the composer. */
  const refreshStats = useCallback((): void => {
    void window.modus.diff
      .sessionStats(sessionId)
      .then((stats: WorkingChangeStats) => {
        if (statsCwdRef.current === session.cwd) {
          setWorkingStats(stats);
        }
      })
      .catch(() => {});
  }, [sessionId, session.cwd]);

  /** Debounced refresh for mid-run updates (file-edit tools landing). */
  const scheduleStatsRefresh = useCallback((): void => {
    if (statsTimerRef.current !== undefined) {
      return;
    }
    statsTimerRef.current = window.setTimeout(() => {
      statsTimerRef.current = undefined;
      refreshStats();
    }, 1200);
  }, [refreshStats]);

  useEffect(
    () => () => {
      window.clearTimeout(statsTimerRef.current);
    },
    [],
  );

  const flushQueued = useCallback((): void => {
    flushFrameRef.current = undefined;
    const queued = queuedRef.current;
    if (queued.length === 0) {
      return;
    }
    queuedRef.current = [];
    setAgentEvents((events) => appendUniqueAgentEvents(events, queued));
  }, []);

  const clearQueued = useCallback((): void => {
    queuedRef.current = [];
    if (flushFrameRef.current !== undefined) {
      cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = undefined;
    }
  }, []);

  // Seed history + subscribe to the live stream. Re-runs only when the pane is
  // pointed at a different session; onSessionsChanged is intentionally not a
  // dependency (a stable "refresh the list" signal must not re-seed the pane).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    let cancelled = false;
    eventHistoryGenerationRef.current += 1;
    eventHistoryPageRef.current = EMPTY_CHAT_EVENT_HISTORY_PAGE;
    setEventHistoryPage(EMPTY_CHAT_EVENT_HISTORY_PAGE);
    setEventSummaryEvents([]);
    prependScrollAnchorRef.current = undefined;
    const optimisticEvents = initialEvents ?? [];
    setAgentEvents(optimisticEvents);
    hub.seedHistory(sessionId, optimisticEvents);
    if (initialEvents && initialEvents.length > 0) {
      onInitialEventsConsumed?.(sessionId);
    }
    setPromptError(undefined);
    setPendingPrompt(false);
    setAborting(false);
    setWorkingStats(undefined);
    hyperPlanRequestId.current += 1;
    hyperPlanOperations.current.reset();
    setHyperPlanReview(undefined);
    refreshStats();

    const unsubscribe = hub.subscribe(sessionId, (item) => {
      const event = item.event;
      if (event.type === "context.updated") {
        return;
      }
      queuedRef.current.push(item);
      if (flushFrameRef.current === undefined) {
        flushFrameRef.current = requestAnimationFrame(flushQueued);
      }
      // Keep the changes strip live while the agent edits files mid-run.
      if (event.type === "tool.ended") {
        scheduleStatsRefresh();
      }
      // Authoritative run-status drives the composer. Once the runtime reports
      // real status, the optimistic pre-turn flag has done its job; on idle the
      // turn is fully over, so also clear any abort-in-flight and refresh stats.
      if (event.type === "session.status") {
        setPendingPrompt(false);
        if (event.status.type === "idle") {
          setAborting(false);
          scheduleStatsRefresh();
        }
      }
    });

    // Seed the newest bounded page. A second snapshot covers events queued
    // before the first read; later live echoes are de-duplicated by event ID.
    void (async () => {
      let page = await window.modus.agent.listEventPage(sessionId, {
        direction: "backward",
        includeSummary: true,
      });
      if (queuedRef.current.length > 0) {
        queuedRef.current = [];
        page = await window.modus.agent.listEventPage(sessionId, {
          direction: "backward",
          includeSummary: true,
        });
      }
      if (!cancelled) {
        const seededEvents = seedEventPage(page, optimisticEvents);
        setAgentEvents(seededEvents);
        // Prefer the scroll offset from the last visit; otherwise land on latest.
        settleSessionViewport(readSessionScroll(sessionId));
      }
    })().catch(() => {
      if (!cancelled) setPromptError("Unable to load this session's history.");
    });

    return () => {
      cancelled = true;
      eventHistoryGenerationRef.current += 1;
      hyperPlanRequestId.current += 1;
      hyperPlanOperations.current.reset();
      const el = scrollContainerRef.current;
      if (el) {
        rememberSessionScroll(sessionId, el.scrollTop);
      }
      unsubscribe();
      clearQueued();
      // View history ≠ keep SDK. Release when the pane leaves and no turn is live;
      // prompt/setModel rehydrate via getOrResume on the next interaction.
      if (!keepRuntimeHotRef.current) {
        void window.modus.agent.releaseRuntime(sessionId);
      }
    };
  }, [sessionId, hub, flushQueued, clearQueued, seedEventPage, settleSessionViewport]);

  /* ── Conversation actions ──────────────────────────────────────────── */

  // A saved session model stays selected across Settings/catalog changes; only a session
  // without a saved model inherits the app default.
  const paneModel = turnModelForPane(defaultModel, session.model);
  const activeCwd = session.cwd;
  const retryStatus = sessionStatus.type === "retry" ? sessionStatus : undefined;
  // The decision card shows only while the plan is unbuilt and not dismissed.
  // Reading the plan's authoritative build status (not a remembered hash) is
  // what stops the card from re-appearing after a build on session re-open.
  const reviewPlan =
    latestPlan &&
    !isRunning &&
    latestPlan.hash !== dismissedPlanHash &&
    effectiveBuildStatus(latestPlan, sessionStatus.type !== "idle") === "not_built"
      ? latestPlan
      : undefined;
  const visibleHyperPlanReview =
    reviewPlan &&
    hyperPlanReview?.planId === reviewPlan.id &&
    hyperPlanReview.planHash === reviewPlan.hash
      ? hyperPlanReview
      : undefined;

  async function reviewPlanWithHyperPlan(plan: PlanRef): Promise<void> {
    if (!plan.spec) return;
    const requestId = ++hyperPlanRequestId.current;
    setPromptError(undefined);
    const sourceSnapshot = hyperPlanSourceProjection(plan);
    setHyperPlanReview({ planId: plan.id, planHash: plan.hash, sourceSnapshot, status: "loading" });
    try {
      const preview = await hyperPlanOperations.current.review({
        sessionId,
        planId: plan.id,
        ...(paneModel ? { model: paneModel } : {}),
      });
      if (requestId === hyperPlanRequestId.current) {
        setHyperPlanReview({
          planId: plan.id,
          planHash: plan.hash,
          sourceSnapshot,
          status: "ready",
          preview,
        });
      }
    } catch (error) {
      if (requestId === hyperPlanRequestId.current) {
        const reason = safeHyperPlanReviewReason(error);
        setHyperPlanReview({
          planId: plan.id,
          planHash: plan.hash,
          sourceSnapshot,
          status: "review-error",
          reason,
        });
        setPromptError(reason);
      }
    }
  }

  async function chooseHyperPlan(choice: HyperPlanChoice): Promise<void> {
    const review = visibleHyperPlanReview;
    if (
      !review ||
      review.status === "loading" ||
      review.status === "choosing" ||
      (review.status === "review-error" && review.originalStart === "pending")
    )
      return;
    const requestId = hyperPlanRequestId.current;
    setPromptError(undefined);
    const isOriginalAfterReviewError = review.status === "review-error" && choice === "original";
    if (isOriginalAfterReviewError) {
      setHyperPlanReview({ ...review, originalStart: "pending" });
    } else if ("preview" in review) {
      setHyperPlanReview({ ...review, status: "choosing", choice });
    } else {
      return;
    }
    try {
      if ("preview" in review) {
        await hyperPlanOperations.current.choose(review.preview, choice);
      } else if (isOriginalAfterReviewError) {
        await hyperPlanOperations.current.buildOriginal({
          sessionId,
          planId: review.planId,
          sourceSnapshot: review.sourceSnapshot,
        });
      } else {
        return;
      }
      if (requestId === hyperPlanRequestId.current) {
        setHyperPlanReview(undefined);
        onSessionsChanged();
      }
    } catch (error) {
      if (requestId !== hyperPlanRequestId.current) return;
      const stage = (error as Partial<HyperPlanOperationError>).stage;
      if (stage === "pending") return;
      setHyperPlanReview((current) => {
        if (!current || current.planId !== review.planId) return current;
        return isOriginalAfterReviewError
          ? { ...current, originalStart: "error" }
          : "preview" in current
            ? {
                ...current,
                status: stage === "choice" ? "choice-error" : "start-error",
                choice,
              }
            : current;
      });
      setPromptError("We couldn’t start that plan. Retry the same choice to continue.");
    }
  }
  const pendingPermission = useMemo(
    () => latestPendingPermissionRequest(stateAgentEvents),
    [stateAgentEvents],
  );
  const pendingQuestion = useMemo(
    () => latestPendingQuestionRequest(stateAgentEvents),
    [stateAgentEvents],
  );

  function submitPrompt(
    message: string,
    context: ContextItem[],
    delivery: PromptDelivery = "normal",
    attachments?: PromptImageAttachment[],
    skills?: SkillSelection[],
    mode?: AgentMode,
    planId?: string,
  ): void {
    if (!message.trim()) {
      return;
    }
    autoScroll.resume();
    setPromptError(undefined);
    setPendingPrompt(true);
    const mergedAttachments = attachments ?? [];
    const leanContext = context.map((item): ContextItem => {
      if (item.type === "design-element") {
        const { screenshotDataUrl: _drop, ...element } = item.element;
        return { ...item, element };
      }
      if (item.type === "design-annotation") {
        const { screenshotDataUrl: _drop, ...annotation } = item.annotation;
        return { ...item, annotation };
      }
      return item;
    });
    // Main ignores the renderer's model as authority and resolves the stored session or agent
    // selection; the payload remains advisory UI state only.
    const userMessageId = `local-user:${crypto.randomUUID()}`;
    setAgentEvents((events) =>
      appendAgentEvents(
        events,
        optimisticUserPromptEvents({
          sessionId,
          userMessageId,
          message,
          ...(mergedAttachments.length > 0 ? { attachments: mergedAttachments } : {}),
          ...(skills && skills.length > 0 ? { skills } : {}),
          ...(leanContext.length > 0 ? { contextItems: leanContext } : {}),
        }),
      ),
    );
    void window.modus.agent
      .prompt({
        context: leanContext,
        delivery,
        sessionId,
        message,
        userMessageId,
        ...(mergedAttachments.length > 0 ? { attachments: mergedAttachments } : {}),
        ...(skills && skills.length > 0 ? { skills } : {}),
        ...(mode ? { mode } : {}),
        ...(paneModel ? { model: paneModel } : {}),
        ...(planId ? { planId } : {}),
      })
      .then(() => onSessionsChanged())
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        setPendingPrompt(false);
        setAgentEvents((events) =>
          appendAgentEvents(events, [
            {
              id: `local:${Date.now()}:${crypto.randomUUID()}:error`,
              event: { type: "runtime.error", sessionId, message: errorMessage },
              createdAt: new Date().toISOString(),
            },
            {
              id: `local:${Date.now()}:${crypto.randomUUID()}:idle`,
              event: { type: "session.status", sessionId, status: { type: "idle" } },
              createdAt: new Date().toISOString(),
            },
          ]),
        );
        setPromptError(errorMessage);
      });
  }

  // Design Mode (in-app browser) routes into this open session: Ctrl+L adds to
  // the composer, Enter sends immediately.
  useEffect(() => {
    const wsId = workspace?.id;
    if (!wsId) {
      return undefined;
    }
    return window.modus.browser.onEvent((event: BrowserEvent) => {
      if (event.type !== "browser.design-select" && event.type !== "browser.design-annotate") {
        return;
      }
      if (event.workspaceId !== wsId) {
        return;
      }
      if (event.intent === "submit") {
        const input = designEventToPromptInput(event);
        submitPrompt(
          input.message,
          input.context,
          isRunning ? "follow-up" : "normal",
          input.attachments,
          undefined,
          input.mode,
        );
        return;
      }
      if (event.type === "browser.design-select") {
        addDesignElement(event);
      }
      if (event.type === "browser.design-annotate") {
        addDesignAnnotation(event);
      }
    });
  });

  async function abortPrompt(): Promise<void> {
    if (aborting) {
      return;
    }
    setPromptError(undefined);
    setPendingPrompt(false);
    setAborting(true);
    try {
      await window.modus.agent.abort(sessionId);
      onSessionsChanged();
    } catch (error) {
      setAborting(false);
      setPromptError(error instanceof Error ? error.message : String(error));
    }
  }

  async function decidePermission(
    request: PermissionRequest,
    decision: PermissionDecision["decision"],
  ): Promise<void> {
    setPromptError(undefined);
    await window.modus.permission.decide({
      requestId: request.id,
      sessionId: request.sessionId,
      action: request.action,
      target: request.target,
      decision,
    });
  }

  async function respondQuestion(answers: QuestionAnswer[], skipped: boolean): Promise<void> {
    if (!pendingQuestion) {
      return;
    }
    setPromptError(undefined);
    await window.modus.questions.respond({ requestId: pendingQuestion.id, answers, skipped });
  }

  async function editAndResend(
    messageId: string,
    message: string,
    attachments?: PromptImageAttachment[],
    contextItems?: ContextItem[],
    skills?: SkillSelection[],
  ): Promise<void> {
    if (!paneModel) {
      throw new Error("No model is configured. Connect a provider in Settings first.");
    }
    await window.modus.agent.rollback({ sessionId, userMessageId: messageId });
    clearQueued();
    const page = await window.modus.agent.listEventPage(sessionId, {
      direction: "backward",
      includeSummary: true,
    });
    setAgentEvents(seedEventPage(page));
    onSessionsChanged();
    refreshStats();
    // Resend under the composer's CURRENT mode (plan/build); submitPrompt also
    // attaches the current model+thinking. Dropping mode here was why an edited
    // resend silently fell back to build mode.
    submitPrompt(message, contextItems ?? [], "normal", attachments, skills, composerMode);
  }

  const openSubagentPreview = useCallback(
    (childSessionId: string): void => {
      // Inspector already owns the live ChatPane for this session — don't dual-mount.
      if (inspectorLiveSessionId === childSessionId) {
        onOpenSubagent?.(childSessionId);
        return;
      }
      setPreviewSubagentId(childSessionId);
    },
    [inspectorLiveSessionId, onOpenSubagent],
  );

  const closeSubagentPreview = useCallback((): void => {
    setPreviewSubagentId(undefined);
  }, []);

  const expandSubagentPreview = useCallback((): void => {
    if (!previewSubagentId) {
      return;
    }
    const id = previewSubagentId;
    setPreviewSubagentId(undefined);
    onOpenSubagent?.(id);
  }, [previewSubagentId, onOpenSubagent]);

  useEffect(() => {
    if (previewSubagentId && subagentSessions && !previewSession) {
      setPreviewSubagentId(undefined);
    }
  }, [previewSubagentId, previewSession, subagentSessions]);

  // Inspector detail took ownership of this session — drop the preview mount.
  useEffect(() => {
    if (inspectorLiveSessionId && previewSubagentId === inspectorLiveSessionId) {
      setPreviewSubagentId(undefined);
    }
  }, [inspectorLiveSessionId, previewSubagentId]);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      {promptError ? (
        <div className="mx-4 mt-2 rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger">
          {promptError}
        </div>
      ) : null}

      {isRunning ? (
        <div
          className="flex min-h-8 shrink-0 items-center gap-2 border-b border-hairline px-5 text-xs text-fg-muted"
          data-testid="chat-run-status"
          role="status"
        >
          <VortexMark className="size-4 shrink-0" />
          <span>{retryStatus ? "Retrying the current turn" : "Working on your request"}</span>
          <button
            className="ml-auto rounded px-1.5 py-0.5 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
            onClick={onOpenActivity}
            type="button"
          >
            Activity
          </button>
        </div>
      ) : null}

      <div className="relative flex min-h-0 min-w-0 flex-1">
        {isLite ? null : (
          <ConversationTimeline blocks={transcriptBlocks} scrollContainer={scrollContainer} />
        )}
        <ChatViewport
          contentRef={autoScroll.contentRef}
          onScroll={handleChatScroll}
          scrollRef={setChatScrollRef}
        >
          {eventHistoryPage.hasOlder || eventHistoryPage.loadingOlder || eventHistoryPage.error ? (
            <div className="flex justify-center px-4 pt-3">
              <button
                className="rounded-md border border-hairline px-2.5 py-1 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                data-testid="chat-load-older-events"
                disabled={eventHistoryPage.loadingOlder}
                onClick={() => void loadOlderEventPage(true)}
                type="button"
              >
                {eventHistoryPage.loadingOlder
                  ? "Loading earlier activity…"
                  : eventHistoryPage.error
                    ? "Could not load earlier activity · Retry"
                    : "Load earlier activity"}
              </button>
            </div>
          ) : null}
          <Timeline
            blocks={transcriptBlocks}
            cwd={activeCwd}
            {...(isLite ? { embedded: true } : {})}
            model={paneModel}
            models={models}
            onEditResend={editAndResend}
            {...(onOpenFile ? { onOpenFile } : {})}
            {...(onOpenPlan ? { onOpenPlan } : {})}
            {...(canPreviewSubagents
              ? { onOpenSubagent: openSubagentPreview }
              : onOpenSubagent
                ? { onOpenSubagent }
                : {})}
            onRestoreCheckpoint={async (checkpointId) => {
              await window.modus.checkpoint.restore({ checkpointId });
              refreshStats();
            }}
            workspaceId={workspace?.id}
          />
        </ChatViewport>
        {!hideComposer ? (
          <SubagentPreviewSheet
            leading={
              previewSession ? (
                isSubagentSessionLive(previewSession.status) ? (
                  <VortexMark className="size-4.5" />
                ) : (
                  <SubagentPreviewProviderMark modelId={previewSession.model} models={models} />
                )
              ) : undefined
            }
            onClose={closeSubagentPreview}
            onExpand={expandSubagentPreview}
            open={Boolean(previewSession)}
            title={previewSession?.subagentTask ?? previewSession?.title ?? "Subagent"}
          >
            {previewSession ? (
              <ChatPane
                defaultModel={defaultModel}
                hideComposer
                hub={hub}
                key={previewSession.id}
                models={models}
                onModelChange={onModelChange}
                onModelConfigChange={onModelConfigChange}
                onOpenReview={onOpenReview}
                onPlanUpdated={onPlanUpdated}
                onSessionsChanged={onSessionsChanged}
                session={previewSession}
                workspace={workspace}
                {...(onOpenFile ? { onOpenFile } : {})}
                {...(onOpenPlan ? { onOpenPlan } : {})}
              />
            ) : null}
          </SubagentPreviewSheet>
        ) : null}
      </div>

      {hideComposer ? null : (
        <div className="min-w-0 max-w-full shrink-0 px-4 pb-4">
          {/* Same .chat-column token as Timeline's content wrapper — one width authority. */}
          <div className="chat-column relative">
            {autoScroll.showScrollToLatest ? (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2">
                <button
                  aria-label="Scroll to latest"
                  className="pointer-events-auto flex size-10 items-center justify-center rounded-full border border-popup-border bg-elevated text-fg-muted shadow-popup outline-none transition-colors duration-100 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus-ring/35"
                  onClick={autoScroll.scrollToLatest}
                  title="Scroll to latest"
                  type="button"
                >
                  <IconArrowDown aria-hidden size={18} stroke={1.7} />
                </button>
              </div>
            ) : null}
            {pendingPermission ? (
              <ApprovalPanel
                key={pendingPermission.id}
                onDecide={(request, decision) => decidePermission(request, decision)}
                request={pendingPermission}
              />
            ) : (
              <>
                {pendingQuestion ? (
                  <QuestionsCard
                    key={pendingQuestion.id}
                    onSkip={() => respondQuestion([], true)}
                    onSubmit={(answers) => respondQuestion(answers, false)}
                    request={pendingQuestion}
                  />
                ) : null}
                {composerReplacement ? (
                  composerReplacement
                ) : reviewPlan ? (
                  <ReviewPlanCard
                    onBuildLocally={() => buildPlanLocally(reviewPlan)}
                    onReviewWithHyperPlan={() => void reviewPlanWithHyperPlan(reviewPlan)}
                    onChoosePlan={(choice) => void chooseHyperPlan(choice)}
                    plan={reviewPlan}
                    {...(visibleHyperPlanReview
                      ? {
                          hyperPlanState:
                            visibleHyperPlanReview.status === "loading"
                              ? { status: "loading" as const }
                              : visibleHyperPlanReview.status === "review-error"
                                ? {
                                    status: "review-error" as const,
                                    ...(visibleHyperPlanReview.reason
                                      ? { reason: visibleHyperPlanReview.reason }
                                      : {}),
                                    ...(visibleHyperPlanReview.originalStart
                                      ? { originalStart: visibleHyperPlanReview.originalStart }
                                      : {}),
                                  }
                                : visibleHyperPlanReview.status === "ready"
                                  ? {
                                      status: "ready" as const,
                                      preview: visibleHyperPlanReview.preview,
                                    }
                                  : {
                                      status: visibleHyperPlanReview.status,
                                      preview: visibleHyperPlanReview.preview,
                                      choice: visibleHyperPlanReview.choice,
                                    },
                        }
                      : {})}
                    onContinuePlanning={() => {
                      setComposerMode("plan");
                      setDismissedPlanHash(reviewPlan.hash);
                    }}
                  />
                ) : (
                  <>
                    <ModusUnavailableNotice
                      modelIds={[paneModel, session.model]}
                      status={modusStatus}
                    />
                    {retryStatus ? <RetryStatusBar status={retryStatus} /> : null}
                    <ComposerDock
                      rails={
                        hasComposerRails ? (
                          <>
                            {runningProcesses.length > 0 ? (
                              <RunningProcessBar
                                nowMs={managedProcesses.nowMs}
                                onStop={managedProcesses.kill}
                                processes={runningProcesses}
                                {...(onOpenTerminal ? { onOpenTerminal } : {})}
                              />
                            ) : null}
                            {workingSubagents.length > 0 ? (
                              <WorkingSubagentBar
                                items={workingSubagents}
                                onOpen={openSubagentPreview}
                              />
                            ) : null}
                            {showChangesRail && workingStats ? (
                              <ChangesStrip
                                onOpenFile={(path) =>
                                  void window.modus.file
                                    .open({ cwd: activeCwd, path })
                                    .catch(() => {})
                                }
                                onReview={() => onOpenReview(activeCwd)}
                                stats={workingStats}
                              />
                            ) : null}
                          </>
                        ) : undefined
                      }
                    >
                      <Composer
                        integrated
                        canSubmit={
                          !branchBlocked &&
                          canSubmitPromptForSession(workspace, session.workspaceId, paneModel)
                        }
                        branchControl={
                          <SessionBranchPicker
                            cwd={activeCwd}
                            isRunning={isRunning}
                            onBlockedChange={setBranchBlocked}
                            onError={setPromptError}
                            sessionId={sessionId}
                          />
                        }
                        contextItems={contextItems}
                        cwd={activeCwd}
                        draft={{
                          images: activeComposerDraft.images,
                          parts: activeComposerDraft.parts,
                          selectedSkills: activeComposerDraft.selectedSkills,
                          value: activeComposerDraft.value,
                        }}
                        isRunning={isRunning}
                        mode={composerMode}
                        model={paneModel}
                        models={models}
                        {...(contextUsage ? { contextUsage } : {})}
                        onAbort={() => void abortPrompt()}
                        onCompact={() => window.modus.agent.compact(sessionId)}
                        onContextChange={setContextItems}
                        onDraftChange={setComposerFields}
                        onModeChange={setComposerMode}
                        {...(onOpenConnections ? { onOpenConnections } : {})}
                        onSubmit={(message, context, delivery, attachments, skills, mode) =>
                          submitPrompt(message, context, delivery, attachments, skills, mode)
                        }
                        workspaceId={workspace?.id}
                      />
                    </ComposerDock>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ChatViewport({
  children,
  onScroll,
  scrollRef,
  contentRef,
}: {
  children: ReactNode;
  onScroll(): void;
  scrollRef: (el: HTMLDivElement | null) => void;
  contentRef: (el: HTMLElement | null) => void;
}) {
  return (
    <m.div
      className="scroll-thin relative min-h-0 min-w-0 max-w-full flex-1 overflow-y-auto overflow-x-clip overscroll-contain [scrollbar-gutter:stable_both-edges]"
      layoutScroll
      onScroll={onScroll}
      ref={scrollRef}
    >
      <div className="flex min-h-full min-w-0 w-full max-w-full flex-col" ref={contentRef}>
        {children}
      </div>
    </m.div>
  );
}

/** Settled preview title mark — same ProviderLogo path as SubagentRow / inspector. */
function SubagentPreviewProviderMark({
  modelId,
  models,
}: {
  modelId?: string | undefined;
  models: ModelInfo[];
}) {
  const model = lookupModel(models, modelId);
  if (!model) {
    return null;
  }
  return (
    <ProviderLogo
      framed={false}
      name={model.providerName ?? model.provider}
      provider={model.provider}
      size="sm"
    />
  );
}
