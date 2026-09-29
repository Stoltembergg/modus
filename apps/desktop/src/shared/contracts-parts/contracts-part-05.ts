import type { ContextItem, ContextKind, DesignElementPayload } from "./contracts-part-04";

export type DesignAnnotationPayload = {
  /** Stable id for de-dup / removal in the composer. */
  id: string;
  /** Browser tab the annotation was captured from. */
  tabId: string;
  /** Page URL at capture time. */
  url: string;
  /** Human-readable chip label. */
  label: string;
  /** Visual annotation mode used in Design Mode. */
  kind: "freehand" | "box";
  /** Annotated region in CSS pixels (root viewport). */
  rect: { x: number; y: number; width: number; height: number };
  /** User note typed in the Design Mode popover, when present. */
  seedText?: string;
  /** Minimal geometry for the drawn mark, in viewport CSS pixels. */
  points?: Array<{ x: number; y: number }>;
  /**
   * Mark color as `#RRGGBB` — same authority as {@link DesignElementPart.color}.
   * First annotation is accent blue; each new gesture picks a random bright hue.
   */
  color?: string;
  /** Annotated region screenshot (PNG data URL): page + drawn mark + pad. */
  screenshotDataUrl?: string;
};

export type ContextSuggestion = {
  id: string;
  type: ContextKind;
  label: string;
  detail: string;
  item: ContextItem;
};

/**
 * A compact, display-only summary of one context item, attached to a sent user
 * message so its chips persist in the timeline bubble (the full `ContextItem`
 * is resolved server-side and not needed for rendering).
 */
export type MessageContextChip = {
  kind: ContextKind;
  /** Primary chip text, e.g. `MDXContent · div "pip install…"` or `app.tsx`. */
  label: string;
  /** Secondary hover detail, e.g. `src/app.tsx:42` for a design element. */
  detail?: string;
  /** Design Mode mark color (`#RRGGBB`), when the chip came from a colored mark. */
  color?: string;
};

export type ResolvedContext = {
  item: ContextItem;
  title: string;
  content: string;
};

/* ── Browser (Cursor-compatible in-app browser) ───────────────────────── */

export type BrowserTabInfo = {
  id: string;
  workspaceId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  devtoolsOpen: boolean;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
  favicon?: string;
};

export type BrowserRecentInfo = {
  id: string;
  workspaceId: string;
  url: string;
  title: string;
  lastOpenedAt: string;
  createdAt: string;
  favicon?: string;
};

export type BrowserEvent =
  | { type: "browser.created"; tab: BrowserTabInfo }
  | { type: "browser.updated"; tab: BrowserTabInfo }
  | { type: "browser.closed"; workspaceId: string; tabId: string }
  | { type: "browser.selected"; workspaceId: string; tabId: string }
  | {
      /** An agent-initiated navigation — the renderer auto-reveals the browser panel. */
      type: "browser.agent-activity";
      workspaceId: string;
      tabId: string;
    }
  | {
      type: "browser.find-result";
      workspaceId: string;
      tabId: string;
      matches: number;
      activeMatchOrdinal: number;
      finalUpdate: boolean;
    }
  | {
      /** Keyboard shortcut captured inside the page that the UI must act on. */
      type: "browser.shortcut";
      workspaceId: string;
      tabId: string;
      shortcut: "focus-address" | "toggle-design";
    }
  | {
      /** Design Mode toggled (from the toolbar, a shortcut, or page-side). */
      type: "browser.design-mode-changed";
      workspaceId: string;
      tabId: string;
      enabled: boolean;
    }
  | {
      /** User selected an element in Design Mode. */
      type: "browser.design-select";
      workspaceId: string;
      tabId: string;
      intent?: "add" | "submit";
      element: DesignElementPayload;
      seedText?: string;
    }
  | {
      /** User marked a visual region in Design Mode. */
      type: "browser.design-annotate";
      workspaceId: string;
      tabId: string;
      intent?: "add" | "submit";
      annotation: DesignAnnotationPayload;
    };

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserConsoleMessage = {
  id: string;
  tabId: string;
  level: "debug" | "info" | "warning" | "error";
  text: string;
  url?: string;
  line?: number;
  column?: number;
  createdAt: string;
};

export type BrowserNetworkRequest = {
  id: string;
  tabId: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  failed?: boolean;
  errorText?: string;
  startedAt: string;
  completedAt?: string;
};

export type DocSource = {
  id: string;
  workspaceId: string;
  title: string;
  path?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
};

export type DocHit = {
  sourceId: string;
  chunkId: string;
  title: string;
  heading?: string;
  path?: string;
  snippet: string;
  score: number;
};

export type AddDocInput = {
  workspaceId: string;
  title: string;
  path?: string;
  url?: string;
};

export type ModelInfo = {
  id: string;
  provider: string;
  providerName?: string;
  name: string;
  available: boolean;
  enabled: boolean;
  configured: boolean;
  source: "builtin" | "custom";
  contextWindow?: number;
  maxTokens?: number;
  supportsThinking: boolean;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  thinkingVariant?: string;
  thinkingOptions?: ThinkingOption[];
  thinkingBudget?: ThinkingBudget;
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingOption = {
  value: string;
  label: string;
  level: ThinkingLevel;
  wireValue?: string | undefined;
};
export type ThinkingBudget = { min?: number; max?: number };
export type ModelInputKind = "text" | "image";

export type JsonObject = Record<string, unknown>;

export type ModelCost = {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
};

export type ModelProviderInfo = {
  id: string;
  name: string;
  source: "builtin" | "custom";
  configured: boolean;
  authSource?: string;
  authLabel?: string;
  authKind?: "api-key" | "oauth";
  modelCount: number;
  enabledModelCount: number;
  baseUrl?: string;
  api?: string;
  pricingAvailability?: "published" | "unknown";
  error?: string;
};

export type ProviderModelConfig = {
  id: string;
  name: string;
  enabled: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  thinkingVariant?: string;
  thinkingOptions?: ThinkingOption[];
  thinkingBudget?: ThinkingBudget;
};

export type ModelProviderDetail = ModelProviderInfo & {
  models: ProviderModelConfig[];
};

export type ProviderConnectionMethod = {
  kind: "api-key" | "oauth";
  label: string;
};

export type ProviderAuthOption = {
  id: string;
  label: string;
};

export type ProviderAuthOperationState = {
  id: string;
  provider: string;
  status:
    | "pending"
    | "select"
    | "browser"
    | "device-code"
    | "prompt"
    | "manual-code"
    | "complete"
    | "error"
    | "cancelled";
  message?: string | undefined;
  options?: ProviderAuthOption[] | undefined;
  url?: string | undefined;
  instructions?: string | undefined;
  userCode?: string | undefined;
  placeholder?: string | undefined;
  allowEmpty?: boolean | undefined;
};

export type ModelSettingsState = {
  providers: ModelProviderInfo[];
  models: ModelInfo[];
  defaultModel?: string;
};

export type ProviderUsageMetric = {
  id: string;
  label: string;
  kind: "budget" | "usage" | "balance" | "rate-limit";
  value: number;
  unit: string;
  limit?: number;
  remaining?: number;
  window?: string;
  resetAt?: string;
};

export type ProviderUsageSource = "openrouter-key" | "deepseek-balance" | "codex-cli";
export type ProviderUsageStatus = "fresh" | "stale" | "unavailable" | "error";
export type ProviderUsageMessage =
  | "unsupported"
  | "not-configured"
  | "authentication-failed"
  | "request-failed"
  | "codex-disabled"
  | "codex-cli-missing"
  | "invalid-response";

export type ProviderAccountUsage = {
  providerId: string;
  providerName: string;
  source?: ProviderUsageSource;
  status: ProviderUsageStatus;
  updatedAt?: string;
  metrics: ProviderUsageMetric[];
  message?: ProviderUsageMessage;
};

export type ProviderLimitsState = {
  accounts: ProviderAccountUsage[];
  codexCliEnabled: boolean;
};

export type ConfigureProviderInput = {
  provider: string;
  apiKey?: string | undefined;
  /**
   * Optional custom endpoint for a built-in provider: relay the provider's
   * native protocol through an OpenAI/Anthropic/Google-compatible gateway.
   * `undefined` leaves the current setting untouched; an empty string reverts
   * to the official endpoint; a URL overrides every built-in model's base URL.
   */
  baseUrl?: string | undefined;
  enabledModelIds?: string[] | undefined;
};

export type ProviderCompatibilityInput = {
  supportsDeveloperRole?: boolean | undefined;
  supportsReasoningEffort?: boolean | undefined;
};

export type ModelCompatibilityInput = {
  /** OpenAI-compatible endpoints: how the thinking/reasoning request field is shaped. */
  thinkingFormat?:
    | "none"
    | "openai"
    | "openrouter"
    | "deepseek"
    | "together"
    | "zai"
    | "qwen"
    | "qwen-chat-template"
    | "string-thinking"
    | undefined;
  supportsUsageInStreaming?: boolean | undefined;
  /**
   * Anthropic-compatible endpoints: send adaptive thinking
   * (`thinking.type: "adaptive"` + `output_config.effort`) instead of the
   * deprecated `budget_tokens` form. Required for Claude Opus 4.7+ class
   * models, where manual budgets return HTTP 400.
   */
  forceAdaptiveThinking?: boolean | undefined;
  /**
   * Anthropic-compatible endpoints: replay thinking blocks whose signatures a
   * relay stripped, instead of downgrading them to plain text.
   */
  allowEmptySignature?: boolean | undefined;
};

export type CustomProviderModelInput = {
  id: string;
  name?: string | undefined;
  api?: string | undefined;
  baseUrl?: string | undefined;
  headers?: Record<string, string> | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  reasoning?: boolean | undefined;
  input?: ModelInputKind[] | undefined;
  cost?: ModelCost | undefined;
  compat?: JsonObject | undefined;
  compatibility?: ModelCompatibilityInput | undefined;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> | undefined;
};

export type UpsertCustomProviderInput = {
  provider: string;
  name: string;
  baseUrl: string;
  apiKey?: string | undefined;
  api?: string | undefined;
  authHeader?: boolean | undefined;
  headers?: Record<string, string> | undefined;
  compat?: JsonObject | undefined;
  compatibility?: ProviderCompatibilityInput | undefined;
  models: CustomProviderModelInput[];
};

/** A custom provider's full stored config, returned for lossless edit round-trips. */
