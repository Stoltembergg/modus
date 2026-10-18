import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * fg-faint audit, "label or secondary text" bucket (pr-glass/audit/fg-faint-audit.md).
 * fg-faint fails contrast over glass (~2.0:1 on strips, 2.6:1 on solid dark panels), and
 * fg-subtle is only 3.99/3.79 on the window, so labels the user has to read moved to
 * fg-muted (same rule as #254, see readableText.test.ts). fg-faint stays only for
 * decorative glyphs, disabled controls, placeholders and dim-by-design status glyphs.
 *
 * #fg-faint-help-empty extends this to the audit's two FLAG buckets (description/helper
 * and empty/loading text) and moves the SubagentRow task line off fg-subtle.
 *
 * Two guards:
 * - ANCHORS: readable labels with a unique content anchor must sit in an element whose
 *   className has text-fg-muted and no text-fg-faint / text-fg-subtle.
 * - FAINT_BUDGET: the number of `fg-faint` uses per touched file may only go down.
 *   Raising a budget needs a reason in review (decorative, disabled or placeholder only).
 */
/** "label or secondary text" bucket (#263). */
const ANCHORS: Record<string, string[]> = {
  "../app/App.tsx": [">{workspace.rootPath}</span>"],
  "../components/Sidebar.tsx": [">Drop here to pin</div>"],
  "../components/sidebar-groups/member-row.tsx": ['title="Lead">', ">{role}</span>"],
  "../components/sidebar-groups/menu.tsx": [">Needs a Lead</span>"],
  "../features/agent/RetryStatusBar.tsx": [">{`retrying"],
  "../features/agent/SearchToolCard.tsx": [">{result.source}</span>"],
  "../features/agent/Timeline.tsx": [
    ">{body}</span> : null}",
    ">Provider-reported · main run</span>",
  ],
  "../features/agent/ToolCard.tsx": ["title={status}>"],
  "../features/composer/SlashMenu.tsx": [">{scopeLabel}</span>"],
  "../features/diff/DiffPanel.tsx": [
    ">{reviewTurn.status}</span>",
    ">{children}</div>;",
    ">{value}</span> : null}",
    ">{dir}</span> : null}",
    ">{commit.author}</span>",
    ">No files changed.</div>",
  ],
  "../features/files/FilesPanel.tsx": [">{viewerNote}</span> : null}"],
  "../features/git/BranchSwitcher.tsx": [">{item.meta}</span>"],
  "../features/groups/CreateGroupDialog.tsx": ["> · {member.agentRole}</span>"],
  "../features/groups/GroupActivityPanel.tsx": [
    ">{row.live.phase}</span>",
    ">{row.live.presence.activity}</div>",
    ">{field.key}</dt>",
  ],
  "../features/groups/GroupComposer.tsx": [
    ">{replyTo.preview}</span>",
    'data-testid="group-composer-active-execution">',
  ],
  "../features/groups/GroupDecisions.tsx": ['>{t("decisions.formerMember")}</span>'],
  "../features/groups/GroupMessageHeader.tsx": [">{memberRole.trim()}</span> : null}"],
  "../features/groups/GroupMessageList.tsx": [">{label}</span>"],
  "../features/groups/GroupMessageRow.tsx": ['data-testid="group-message-to">'],
  "../features/groups/GroupTaskDetails.tsx": [
    'onClick={onClose} type="button">',
    '>{t("taskDetails.owner")}</span>',
    '>{t("taskDetails.reviewer")}</span>',
  ],
  "../features/groups/MemberName.tsx": ['data-testid="member-id-suffix">'],
  "../features/groups/prompt-kit/PromptKit.tsx": [
    ">{role.trim()}</span> : null}",
    ">{badge}</span>",
  ],
  "../features/plan/PlanAcceptanceCriteria.tsx": [
    ">({item.kind})</span>",
    ">+{evidence.length - 4} more references</li>",
  ],
  "../features/settings/CustomProviderForm.tsx": [
    '>{t("settings.customProvider.testContacting")}</span>',
  ],
  "../features/settings/sections/SettingsSidebar.tsx": [">{title}</h3>"],
  "../features/settings/sections/limits.tsx": [
    ">{row.providerName}</div>",
    ">Window: {metric.window}</div>",
  ],
  "../features/settings/sections/project-memory.tsx": [">{href}</span>"],
  "../features/settings/settings-provider-ui.tsx": [">{children}</span>"],
  "../features/sources/PromptSources.tsx": [
    ">Open</span>",
    ">File</span>",
    ">Connection</span>",
    ">{source.detail}</span>",
  ],
  "../features/terminal/TerminalPanel.tsx": [">No terminals</div>"],
};

/** "description / helper" and "empty / loading" buckets, plus the SubagentRow task line. */
const HELP_EMPTY_ANCHORS: Record<string, string[]> = {
  "../app/App.tsx": ["No recent workspaces"],
  "../components/code/CodeViewer.tsx": ["Loading…"],
  "../components/question/QuestionCard.tsx": ["{choice.description}"],
  "../features/agent/ActivityTimeline.tsx": ['? t("shell.activity.loadingEarlier")'],
  "../features/agent/SessionTitlePopover.tsx": ['>{branch ?? "No branch"}</span>'],
  "../features/agent/SubagentRow.tsx": [">{task}</span>"],
  "../features/agent/TodosCard.tsx": ["data-todos-empty>"],
  // The New Agent dialog has no visible subtitle any more; its picker labels are readable.
  "../features/agents/AvatarOptionGroup.tsx": ["id={labelId}>"],
  "../features/agents/ModelPicker.tsx": [">No models match</p>"],
  "../features/composer/SlashMenu.tsx": [
    '{item.kind === "skill" ? "Skills" : "Commands"}',
    ">{item.description}</span>",
  ],
  "../features/diff/DiffPanel.tsx": [">Loading files…</div>"],
  "../features/files/FilesPanel.tsx": [
    '{cwd ? t("files.empty") : t("files.noWorkspace")}',
    '>{t("files.noMatches")}</div>',
  ],
  "../features/git/BranchSwitcher.tsx": [">No branches</div>"],
  "../features/groups/CreateGroupDialog.tsx": ["editGroup.name} · ", ">{hint}</p> : null}"],
  "../features/groups/GroupActivityPanel.tsx": [
    '{t.plural("activity.tokensSummary", executionCount, { total: formatTokenCount(grand) })}',
    "{row.live.thoughtPreview}",
    '>{t("activity.noHandoff")}</span>',
  ],
  "../features/groups/GroupDecisions.tsx": ['>{t("decisions.empty")}</div>'],
  "../features/groups/GroupMessageList.tsx": ['>{t("list.loadingOlder")}</div>'],
  "../features/groups/GroupProactivityControls.tsx": [
    '>{t("proactivity.defaultDescription")}</p>',
    '>{t("proactivity.loading")}</p>',
    '>{t("proactivity.noPending")}</p>',
    'data-testid="group-suggestion-origin">',
    'data-testid="group-suggestion-destination">',
  ],
  "../features/groups/NewGroupModal.tsx": [
    '{t("newGroup.description")}',
    ">{desc}</p>",
    '>{t("newGroup.copyHint")}</p>',
    '>{t("newGroup.loadingAgents")}</p>',
    '>{t("newGroup.noCopyable")}</p>',
    '{t("newGroup.customSource")}',
  ],
  "../features/inspector/SubagentsPanel.tsx": [">{description}</span>"],
  "../features/plan/PlanAcceptanceCriteria.tsx": [
    ">Run {group.runId}</p>",
    ">No run linked</p>",
    ">No linked evidence for the latest run.</p>",
  ],
  "../features/plan/PlanTool.tsx": [">{step.detail}</p>", ">No plan content provided.</p>"],
  "../features/preview/engines/DocxEngine.tsx": ["{error}"],
  "../features/preview/engines/PdfEngine.tsx": ["{error}"],
  "../features/preview/engines/PptxEngine.tsx": ["{error}"],
  "../features/preview/engines/XlsxEngine.tsx": ["{error}", "Loading spreadsheet…"],
  "../features/projects/groupsMigration.tsx": [
    '{t("shell.groupsMoved.backup", { path: notice.backup })}',
  ],
  "../features/settings/UnofficialProviderNotice.tsx": [
    '>{t("settings.providers.antigravityRiskReview")}</p>',
  ],
  "../features/settings/form-controls.tsx": [">{emptyLabel}</p> : null}"],
  "../features/settings/sections/failure-blacklist.tsx": [
    '{entries.length} active {entries.length === 1 ? "entry" : "entries"}',
  ],
  "../features/settings/sections/harness-insights.tsx": [
    "Patterns are suggestions from structured local activity. Promotion requires your explicit",
    "{limitations.slice(0, 4).map((limitation) => (",
  ],
  "../features/settings/sections/integrations.tsx": [
    '{t("settings.integrations.accountsSubheading")}',
    '{t("settings.integrations.allowedOperationsHint", {',
    '{t("settings.integrations.allowPlatformRequirements")}',
  ],
  "../features/settings/sections/limits.tsx": [
    "Configured metadata for enabled models; these are not live account quotas.",
    "Provider-reported values only. Budgets and balances are not rate limits.",
  ],
  "../features/settings/sections/mcp.tsx": [
    "id={noteId}>",
    'role="status">',
    ">{hint}</span> : null}",
  ],
  "../features/settings/sections/model-provider.tsx": [
    '{t("settings.providers.chooseSignInMethod")}',
    ">{operation.instructions}</p>",
    '{t("settings.providers.unofficialProviderRequiredBeforeOAuth")}',
  ],
  "../features/settings/sections/project-memory.tsx": [
    ">{attribution}</span>",
    ">External page content is not verified.</p>",
    "Loading project memory…",
    ">{description}</p>",
    ">No memories in this scope yet.</p>",
  ],
  "../features/settings/settings-provider-ui.tsx": [">{description}</span>"],
  "../features/terminal/TerminalPanel.tsx": ["No active terminals. Press + to start one."],
};

function mergeAnchors(...maps: Record<string, string[]>[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const map of maps)
    for (const [path, list] of Object.entries(map)) out[path] = [...(out[path] ?? []), ...list];
  return out;
}

const FAINT_BUDGET: Record<string, number> = {
  "../app/App.tsx": 0,
  "../components/Sidebar.tsx": 9,
  "../components/code/CodeViewer.tsx": 0,
  "../components/question/QuestionCard.tsx": 11,
  "../components/sidebar-groups/member-row.tsx": 0,
  "../components/sidebar-groups/menu.tsx": 1,
  "../components/ui/Panel.tsx": 1,
  "../features/agent/ActivityGroup.tsx": 1,
  "../features/agent/ActivityTimeline.tsx": 0,
  "../features/agent/RetryStatusBar.tsx": 0,
  "../features/agent/SearchToolCard.tsx": 7,
  "../features/agent/SessionTitlePopover.tsx": 0,
  "../features/agent/SubagentRow.tsx": 1,
  "../features/agent/Timeline.tsx": 3,
  "../features/agent/TodosCard.tsx": 10,
  "../features/agent/ToolCard.tsx": 5,
  "../features/agent/ToolGroup.tsx": 1,
  "../features/agent/changes/ChangeStats.tsx": 2,
  "../features/agent/diff/InlineDiff.tsx": 2,
  "../features/agents/AgentDialog.tsx": 3,
  "../features/agents/AvatarOptionGroup.tsx": 0,
  "../features/agents/ModelPicker.tsx": 5,
  "../features/composer/ContextMentionMenu.tsx": 1,
  "../features/composer/SlashMenu.tsx": 1,
  "../features/diff/CommitDialog.tsx": 3,
  "../features/diff/DiffPanel.tsx": 10,
  "../features/diff/FileDiffPreview.tsx": 0,
  "../features/files/FilesPanel.tsx": 6,
  "../features/git/BranchSwitcher.tsx": 1,
  "../features/git/SessionBranchPicker.tsx": 0,
  "../features/groups/CreateGroupDialog.tsx": 4,
  "../features/groups/GroupActivityPanel.tsx": 4,
  "../features/groups/GroupAgentsPopover.tsx": 0,
  "../features/groups/GroupComposer.tsx": 4,
  "../features/groups/GroupDecisions.tsx": 2,
  "../features/groups/GroupMemberQuestions.tsx": 0,
  "../features/groups/GroupMessageHeader.tsx": 2,
  "../features/groups/GroupMessageList.tsx": 1,
  "../features/groups/GroupMessageRow.tsx": 2,
  "../features/groups/GroupProactivityControls.tsx": 1,
  "../features/groups/GroupTaskDetails.tsx": 2,
  "../features/groups/GroupTaskPanel.tsx": 4,
  "../features/groups/MemberName.tsx": 0,
  "../features/groups/NewGroupModal.tsx": 10,
  "../features/groups/prompt-kit/PromptKit.tsx": 6,
  "../features/inspector/SubagentsPanel.tsx": 5,
  "../features/plan/PlanAcceptanceCriteria.tsx": 1,
  "../features/plan/PlanTool.tsx": 12,
  "../features/preview/PreviewHost.tsx": 0,
  "../features/preview/engines/DocxEngine.tsx": 0,
  "../features/preview/engines/PdfEngine.tsx": 0,
  "../features/preview/engines/PptxEngine.tsx": 0,
  "../features/preview/engines/XlsxEngine.tsx": 0,
  "../features/projects/groupsMigration.tsx": 1,
  "../features/settings/ApprovalModeSettings.tsx": 0,
  "../features/settings/AskMissingTargetSetting.tsx": 0,
  "../features/settings/CustomProviderForm.tsx": 4,
  "../features/settings/UnofficialProviderNotice.tsx": 1,
  "../features/settings/form-controls.tsx": 5,
  "../features/settings/sections/SettingsSidebar.tsx": 2,
  "../features/settings/sections/account.tsx": 0,
  "../features/settings/sections/failure-blacklist.tsx": 0,
  "../features/settings/sections/harness-insights.tsx": 1,
  "../features/settings/sections/integrations.tsx": 9,
  "../features/settings/sections/limits.tsx": 3,
  "../features/settings/sections/mcp.tsx": 12,
  "../features/settings/sections/model-provider.tsx": 7,
  "../features/settings/sections/project-memory.tsx": 3,
  "../features/settings/sections/rules.tsx": 3,
  "../features/settings/sections/skills.tsx": 2,
  "../features/settings/settings-provider-ui.tsx": 16,
  "../features/sources/PromptSources.tsx": 1,
  "../features/terminal/TerminalPanel.tsx": 0,
};

/** className of the JSX element whose opening tag (or direct text) contains `index`. */
function classNameAt(source: string, index: number): string {
  const tag = source.lastIndexOf("<", index);
  const name = source.slice(tag).match(/^<[\w.]+[^>]*?className="([^"]*)"/)?.[1];
  if (name === undefined) throw new Error(`no className before ${source.slice(index, index + 40)}`);
  return name;
}

function occurrences(source: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("fg-faint mixed labels", () => {
  it("readable labels use fg-muted, never fg-faint or fg-subtle", () => {
    let checked = 0;
    for (const [path, anchors] of Object.entries(mergeAnchors(ANCHORS, HELP_EMPTY_ANCHORS))) {
      const source = read(path);
      for (const anchor of anchors) {
        const at = occurrences(source, anchor);
        expect(at, `${path}: ${anchor} is unique`).toHaveLength(1);
        const name = classNameAt(source, at[0] as number);
        expect(name, `${path}: ${anchor}`).toMatch(/(^|\s)text-fg-muted(\s|$)/);
        expect(name, `${path}: ${anchor}`).not.toMatch(/text-fg-(faint|subtle)/);
        checked += 1;
      }
    }
    expect(checked).toBe(116);
  });

  it("touched files do not gain fg-faint uses", () => {
    for (const [path, budget] of Object.entries(FAINT_BUDGET)) {
      const uses = read(path).match(/fg-faint/g)?.length ?? 0;
      expect(uses, `${path}: fg-faint uses (budget ${budget})`).toBeLessThanOrEqual(budget);
    }
  });
});
