/** Gap 4 contracts split part 7/7 — do not edit by hand */
import type { AgentMode } from "./contracts-part-04";
import type { ConfigScope, SkillScope, SubagentScope } from "./contracts-part-06";

export type SkillSelection = {
  name: string;
  /** Absolute path of the selected skill's SKILL.md. */
  path: string;
};

/**
 * A discovered agent skill. Skills follow the portable `SKILL.md` standard
 * (YAML frontmatter `name` + `description`, Markdown body of instructions),
 * compatible with Claude/Cursor/opencode skill folders. They can be invoked
 * manually with `/name` in the composer, or surfaced to the agent by relevance.
 */
export type SkillInfo = {
  /** Slash-invocable name, e.g. "code-review". */
  name: string;
  description: string;
  scope: SkillScope;
  /** Config family the skill came from (".modus", ".cursor", ".claude", …). */
  source: string;
  /** Absolute path of the skill's SKILL.md (or `<name>.md`). */
  path: string;
  enabled: boolean;
  allowImplicitInvocation: boolean;
  /** Tools the skill declares it needs, when present in frontmatter. */
  allowedTools?: string[];
};

/** A skill plus its full Markdown instruction body. */
export type SkillDetail = SkillInfo & { body: string };

export type CreateSkillInput = {
  cwd: string;
  /** Human/slash name; normalized to a kebab-case folder name. */
  name: string;
  description: string;
  /** Markdown instructions written to SKILL.md after frontmatter. */
  body: string;
};

export type SubagentInfo = {
  name: string;
  description: string;
  scope: SubagentScope;
  source: string;
  /**
   * Absolute Markdown path for user/workspace agents, or a synthetic
   * `builtin:<name>` id for Modus defaults (not a real file).
   */
  path: string;
  model: string;
  readOnly: boolean;
  tools?: string[];
  disallowedTools?: string[];
  isolation: "shared" | "worktree";
  editable: boolean;
  deletable: boolean;
};

export type SubagentDetail = SubagentInfo & { body: string };

export type CreateSubagentInput = {
  cwd: string;
  /** New subagents are written to the selected agents folder. */
  scope?: ConfigScope | undefined;
  name: string;
  description: string;
  model?: string;
  readOnly: boolean;
  tools?: string[];
  disallowedTools?: string[];
  isolation?: "shared" | "worktree";
  body: string;
};

export type UpdateSubagentInput = CreateSubagentInput & {
  path: string;
};

/**
 * What the renderer offers for an available update: install in place, or open the
 * GitHub Release page (Linux deb installs, macOS installs that cannot be replaced).
 */
export type UpdateAction = "install" | "download-page";

/** App auto-update state pushed from the main-process update service. */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string; action: UpdateAction }
  | { status: "downloading"; version: string; percent: number }
  /** Downloaded and verified; the restart follows right away or after agents finish. */
  | { status: "ready"; version: string }
  /** Ready, but the restart waits until no agent turn is running. */
  | { status: "waiting-for-agents"; version: string }
  | { status: "installing"; version: string }
  /** Only user-initiated downloads/installs fail visibly; background checks stay idle. */
  | {
      status: "failed";
      version: string;
      retryable: boolean;
      action: UpdateAction;
      /**
       * The install was handed off but the app did not quit (install watchdog), and the
       * pending install still completes when Modus closes: AppImage already replaced
       * the file; the macOS swap script waits up to 10 minutes from the handoff, and
       * at that deadline the service drops this flag (plain retryable failure). Never
       * set on Windows (the NSIS installer gives up when it cannot close the app).
       */
      appliesOnQuit?: true;
    };

/**
 * In-memory UI state carried across an update restart (userData/updater/restore-snapshot.json).
 * Drafts keep the text and mode only: images, context chips and inline mentions are dropped.
 */
export type UpdateRestoreUiState = {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  /** Keyed by session id; only sessions with a non-empty draft. */
  drafts: Record<string, { text: string; mode: AgentMode }>;
  /** The start-screen (hero) composer: text and mode only, like the drafts. */
  hero: { text: string; mode: AgentMode };
  sidebar: { open: boolean; width: number };
  inspector: { open: boolean; width: number; tab: UpdateRestoreInspectorTab };
  settingsOpen: boolean;
};

export type UpdateRestoreInspectorTab =
  | "changes"
  | "plan"
  | "files"
  | "subagents"
  | "browser"
  | "terminal"
  | "security";
