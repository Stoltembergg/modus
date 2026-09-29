/** Gap 4 contracts split part 4/7 — do not edit by hand */
export type DiffReviewReady = {
  state: "ready";
  files: ReviewFile[];
  totals: DiffTotals;
  /** Branch ref chosen by Git when the caller omitted an explicit base. */
  resolvedBase?: string;
  /** Present for Last Turn so the UI can distinguish live and frozen comparisons. */
  turn?: {
    runId: string;
    status: AgentRunStatus;
    live: boolean;
  };
};

export type DiffReview =
  | DiffReviewReady
  | {
      state: "unavailable";
      reason: "no-turn" | "missing-start" | "missing-end" | "worktree-mismatch";
      message: string;
    }
  | { state: "superseded" };

export type FileDiff = {
  path: string;
  diff: string;
  mode?: DiffMode;
};

/** Compact single-file patch for the read-only Git review renderer. */
export type DiffFilePatch = {
  patch: string;
  binary: boolean;
  truncated: boolean;
  bytes: number;
  maxLineLength: number;
};

export type PermissionAction =
  | "shell.execute"
  | "file.write"
  | "file.delete"
  | "git.write"
  | "mcp.call"
  | "external.open"
  | "browser.control";

export type PermissionDecision = {
  id: string;
  action: PermissionAction;
  target: string;
  decision: "allow-once" | "allow-workspace" | "deny";
  createdAt: string;
};

/**
 * Approval mode chosen in Settings (global default, optional per-project
 * override). Collapses Codex's approval×sandbox preset into a single "when to
 * prompt" axis (Modus has no OS sandbox): the decision logic + per-mode
 * metadata live in `shared/approval.ts`.
 */
export type ApprovalMode = "request-approval" | "auto" | "full-access";

/** Settings / IPC snapshot of resolved approval mode layers. */
export type ApprovalModeState = {
  effective: ApprovalMode;
  global: ApprovalMode;
  /** `null` = project follows global (no override). Omitted cwd → always null. */
  project: ApprovalMode | null;
};

/**
 * Composer execution mode. `build` is the normal coding agent. `plan` runs the
 * read-only planning harness (research + write a single plan.md via plan_write;
 * no edit/write/bash). Carried per-prompt so the user can toggle it freely.
 */
export type AgentMode = "build" | "plan" | "spec";

/** Branch / remote / sync state for the git review panel header + commit dialog. */
export type GitStatusSummary = {
  /** Current branch name, or undefined when HEAD is detached. */
  branch?: string;
  /** True when at least one remote is configured. */
  hasRemote: boolean;
  /** True when the current branch tracks an upstream ref. */
  hasUpstream: boolean;
  /** Commits on the current branch not yet on the upstream (push count). */
  ahead: number;
  /** Commits on the upstream not yet local (pull count). */
  behind: number;
  /** Total +added lines across the working tree (staged + unstaged). */
  added: number;
  /** Total -removed lines across the working tree (staged + unstaged). */
  removed: number;
  /** Number of staged files. */
  stagedCount: number;
  /** Number of unstaged (tracked-modified + untracked) files. */
  unstagedCount: number;
  /** True while Git has an unfinished merge in this checkout. */
  mergeInProgress: boolean;
  /** Files with unresolved merge entries, when any. */
  conflictFiles: string[];
};

/** Result of a commit and/or push action surfaced back to the renderer. */
export type GitCommitResult = {
  committed: boolean;
  pushed: boolean;
  /** Short commit hash when a commit was created. */
  commit?: string;
  /** Human-readable git output (commit + push), shown on error or as a toast. */
  output: string;
};

/** A single git branch (local head or remote-tracking ref). */
export type GitBranch = {
  /** Display + checkout name. Locals are short ("main"); remotes keep the remote prefix ("origin/main"). */
  name: string;
  /** True for the currently checked-out local branch. */
  current: boolean;
  /** True for remote-tracking refs (refs/remotes/*). */
  remote: boolean;
  /** Upstream tracking ref for a local branch, when configured. */
  upstream?: string;
  /** Linked worktree path when this local branch is checked out elsewhere. */
  worktreePath?: string;
};

/** Local + remote branch listing for the commit dialog branch switcher. */
export type GitBranchSummary = {
  /** Current branch name, or undefined when HEAD is detached. */
  current?: string;
  /** Local branches (refs/heads), current first. */
  local: GitBranch[];
  /** Remote-tracking branches (refs/remotes), excluding origin/HEAD. */
  remote: GitBranch[];
};

/** Result of a network/branch git action (checkout, pull, fetch, create branch). */
export type GitActionResult = {
  /** Human-readable git output, shown on error or as a toast. */
  output: string;
  kind?: "ok" | "worktree";
  branch?: string;
  worktreePath?: string;
};

/**
 * Broadcast when a watched repository changes on disk (commit, stage, branch
 * switch, fetch, or a working-tree edit). Drives live refresh of the Changes
 * panel + commit dialog. `kind` is the most-specific area that changed in the
 * debounced burst, so the renderer can refresh narrowly if it wants.
 */
export type GitChangeEvent = {
  cwd: string;
  kind: "working" | "index" | "head" | "refs" | "remote-refs" | "config" | "lock";
};

/**
 * One commit in the Source Control "All commits" scope. Files are fetched
 * lazily per commit through `diff.review`, keeping the log payload bounded.
 */
export type GitCommit = {
  /** Full 40-char object id (used as the authoritative diff base). */
  hash: string;
  /** Abbreviated id for display. */
  shortHash: string;
  /** First line of the commit message. */
  subject: string;
  /** Author name. */
  author: string;
  /** Author date, ISO 8601. */
  date: string;
  /** Human relative date ("3 hours ago"), from git itself. */
  relativeDate: string;
  /** Parent object ids (`%P`). Empty for root; length ≥ 2 means merge. */
  parents: string[];
  /** Ref decorations from git `%D`, already split on `, ` (may include `HEAD -> …`, `tag: …`). */
  refs: string[];
};

export type ContextKind =
  | "file"
  | "folder"
  | "doc"
  | "terminal"
  | "browser"
  | "git-diff"
  | "past-chat"
  | "project-summary"
  | "recent-changes"
  | "rules"
  | "search"
  | "design-element"
  | "design-annotation"
  /**
   * Capture-time text selection from a preview surface (PDF TextLayer, etc.).
   * Self-contained like design-element — `resolveContext` uses `text`, never
   * re-reads the binary file.
   */
  | "excerpt";

export type ContextItem =
  | { type: "file"; path: string; range?: { fromLine?: number; toLine?: number } }
  | { type: "folder"; path: string }
  | { type: "doc"; docId: string; title: string; query?: string }
  | { type: "terminal"; terminalId: string; range?: { fromLine?: number; toLine?: number } }
  | { type: "browser"; workspaceId?: string; viewId?: string }
  | { type: "git-diff"; mode: "working-state" | "branch"; base?: string }
  | { type: "past-chat"; sessionId: string; title: string }
  | { type: "project-summary" }
  | { type: "recent-changes"; limit?: number }
  | { type: "rules" }
  | { type: "search"; query: string }
  /**
   * A page element captured from the in-app browser's Design Mode (point-and-
   * select). Self-contained: the payload is a point-in-time snapshot of the
   * element (the live page may have changed by the time the agent reads it), so
   * unlike file/doc refs it is NOT re-resolved from an id — `resolveContext`
   * just formats `element` into model-readable text.
   */
  | { type: "design-element"; element: DesignElementPayload }
  | { type: "design-annotation"; annotation: DesignAnnotationPayload }
  /**
   * Selected text captured from an in-app preview (PDF TextLayer today;
   * other engines later). `text` is the authority; `locator` is display-only
   * (e.g. `p.3` from `data-page`).
   */
  | { type: "excerpt"; path: string; text: string; locator?: string };

/** Design Mode theme accent — always the first mark / first multi-select slot. */
export const DESIGN_ACCENT_COLOR = "#1D9BFF";

/**
 * A point-in-time capture of a DOM element selected via the browser's Design
 * Mode. Built in the page (identity/source via React fiber `_debugSource`,
 * with a DOM-path fallback) + main process (element-clipped screenshot), then
 * carried verbatim into the chat composer as a removable chip + thumbnail.
 */
export type DesignElementPart = {
  /** Chip label, e.g. `MDXContent · span "Kimi K2.7 Co…"`. */
  label: string;
  /** Lowercased tag name, e.g. "span". */
  tagName: string;
  /** React component display name (fiber `_debugOwner`), when resolvable. */
  componentName?: string;
  /** Source location from React fiber `_debugSource` (dev builds only). */
  source?: { file: string; line: number; column?: number };
  /** Stable CSS selector — the universal fallback when there's no source map. */
  domPath: string;
  /** Truncated visible text. */
  text?: string;
  /** A few salient computed styles (color/font/spacing/layout…) for the model. */
  styleSummary?: Record<string, string>;
  /**
   * Salient HTML attributes (id, class, href, role, aria-*, type, name, alt,
   * title, placeholder, value, data-*…) — Cursor parity for element identity.
   */
  attributes?: Record<string, string>;
  /**
   * Ancestor chain (nearest first, ~4 levels), giving the element's position in
   * the page structure: tag + id + classes + role + short text per level.
   */
  ancestors?: Array<{
    tag: string;
    id?: string;
    classes?: string;
    role?: string;
    text?: string;
  }>;
  /** Serializable React props from the element's host fiber (primitives only). */
  props?: Record<string, string>;
  /** Element bounding box in CSS pixels (root viewport). */
  rect: { x: number; y: number; width: number; height: number };
  /**
   * Mark color as `#RRGGBB` — authority for highlight, ink, and composer chips.
   * First mark in a session is always {@link DESIGN_ACCENT_COLOR}; later marks
   * are random bright hues assigned at capture time.
   */
  color?: string;
};

export type DesignElementContentPart =
  | { type: "text"; text: string }
  | { type: "element"; index: number };

export type DesignElementPayload = DesignElementPart & {
  /** Stable id for de-dup / removal in the composer. */
  id: string;
  /** Browser tab the element was captured from. */
  tabId: string;
  /** Page URL at capture time. */
  url: string;
  /** Multi-select members, when the user Shift-clicked multiple elements. */
  elements?: DesignElementPart[];
  /** Inline order from the Design Mode prompt: text and selected element chips. */
  contentParts?: DesignElementContentPart[];
  /** Element-clipped screenshot as a data URL (PNG). Shown as a thumbnail. */
  screenshotDataUrl?: string;
};

