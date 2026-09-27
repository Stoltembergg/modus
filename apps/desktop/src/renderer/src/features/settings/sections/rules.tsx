function RulesSettingsPanel({ cwd }: { cwd: string | undefined }) {
  const [rules, setRules] = useState<RuleFileInfo[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgentsState | undefined>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rulesError, setRulesError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  async function refresh(): Promise<void> {
    if (!cwd) {
      setRules([]);
      setAgents(undefined);
      setDraft("");
      return;
    }
    setLoading(true);
    setRulesError(undefined);
    try {
      const [nextRules, nextAgents] = await Promise.all([
        window.modus.rules.list(cwd),
        window.modus.rules.getAgents(cwd),
      ]);
      setRules(nextRules);
      setAgents(nextAgents);
      setDraft(nextAgents.exists ? nextAgents.content : nextAgents.example);
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is recreated each render; cwd is the real trigger.
  useEffect(() => {
    void refresh();
  }, [cwd]);

  async function openRule(rule: RuleFileInfo): Promise<void> {
    if (!cwd) {
      return;
    }
    try {
      await window.modus.file.open({ cwd, path: rule.relPath });
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveAgents(): Promise<void> {
    if (!cwd) {
      return;
    }
    setSaving(true);
    setRulesError(undefined);
    setMessage(undefined);
    try {
      const next = await window.modus.rules.saveAgents({ cwd, content: draft });
      setAgents(next);
      setDraft(next.content);
      setMessage(next.exists ? "AGENTS.md saved." : "AGENTS.md created.");
      setRules(await window.modus.rules.list(cwd));
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function useExample(): void {
    if (!agents) {
      return;
    }
    setDraft(agents.example);
    setMessage(undefined);
  }

  const autoApplied = rules.filter((rule) => rule.mode === "always");
  const dirty = agents ? draft !== (agents.exists ? agents.content : agents.example) : false;
  const exampleLoaded = Boolean(agents && !agents.exists && draft === agents.example);

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
              disabled={!cwd || loading}
              onClick={() => void refresh()}
              type="button"
            >
              <IconRefresh size={14} stroke={1.7} />
              {loading ? <ShinyText>Refreshing…</ShinyText> : "Refresh"}
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
              disabled={!cwd || loading || saving || (!dirty && Boolean(agents?.exists))}
              onClick={() => void saveAgents()}
              type="button"
            >
              <IconCheck size={13} stroke={2} />
              {saving ? (
                <ShinyText className="text-canvas">Saving…</ShinyText>
              ) : agents?.exists ? (
                "Save"
              ) : (
                "Create AGENTS.md"
              )}
            </button>
          </>
        }
        description="Project rules are injected into every agent session automatically when marked Always Apply (AGENTS.md, CLAUDE.md, .cursorrules, or .cursor/rules/*.mdc with alwaysApply: true). Other rules stay available through the @rules context attachment."
        title="Rules"
      />

      {rulesError ? <p className="-mt-4 text-danger text-xs">{rulesError}</p> : null}
      {message ? <p className="-mt-4 text-success text-xs">{message}</p> : null}

      <SettingsSection
        title="AGENTS.md"
        description={
          exampleLoaded
            ? "Starter example — edit freely, then create the file in this workspace."
            : "Always-applied workspace rules. Edit here or open the file on disk."
        }
      >
        {!cwd ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">Open a workspace to edit project rules.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <ReadOnlyPill>{agents?.exists ? "On disk" : "Example (not saved)"}</ReadOnlyPill>
              <button
                className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
                disabled={!agents || loading || saving}
                onClick={useExample}
                type="button"
              >
                Reset to example
              </button>
              {agents?.exists ? (
                <button
                  className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
                  disabled={loading || saving}
                  onClick={() =>
                    void openRule({
                      path: agents.path,
                      relPath: "AGENTS.md",
                      source: "agents-md",
                      mode: "always",
                      size: new TextEncoder().encode(agents.content).byteLength,
                    })
                  }
                  type="button"
                >
                  <IconFileText size={14} stroke={1.7} />
                  Open file
                </button>
              ) : null}
            </div>
            <textarea
              className="scroll-thin min-h-[280px] w-full resize-y rounded-lg border border-hairline-soft bg-panel px-4 py-3 font-mono text-sm text-fg leading-6 outline-none placeholder:text-fg-faint focus:border-focus-ring disabled:opacity-60"
              disabled={loading || saving}
              onChange={(event) => {
                setDraft(event.target.value);
                setMessage(undefined);
              }}
              placeholder="Project rules…"
              spellCheck={false}
              value={loading ? "" : draft}
            />
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Detected rule files">
        {!cwd ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">Open a workspace to discover project rules.</p>
          </div>
        ) : loading && rules.length === 0 && !agents ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6 text-sm text-fg-muted">
            <ShinyText>Scanning workspace…</ShinyText>
          </div>
        ) : rules.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">
              No rule files on disk yet. Save the example above to create{" "}
              <span className="font-mono text-xs">AGENTS.md</span>, or add{" "}
              <span className="font-mono text-xs">.cursor/rules/*.mdc</span> with{" "}
              <span className="font-mono text-xs">alwaysApply: true</span>.
            </p>
          </div>
        ) : (
          <SettingsList>
            {rules.map((rule) => (
              <button
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-hairline-soft border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-hover"
                key={rule.path}
                onClick={() => void openRule(rule)}
                type="button"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex size-5 shrink-0 items-center justify-center text-fg-faint">
                      <IconGavel size={15} stroke={1.7} />
                    </span>
                    <span className="shrink-0 font-mono text-sm text-fg">{rule.relPath}</span>
                    <RuleModeBadge mode={rule.mode} />
                  </div>
                  {rule.description ? (
                    <p className="mt-1 truncate pl-7.5 text-xs text-fg-subtle">
                      {rule.description}
                    </p>
                  ) : null}
                  {rule.globs ? (
                    <p className="mt-0.5 truncate pl-7.5 font-mono text-2xs text-fg-faint">
                      globs: {rule.globs}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 rounded bg-chip-faint px-1.5 py-px text-2xs text-fg-faint">
                  {ruleSourceLabel(rule.source)}
                </span>
              </button>
            ))}
          </SettingsList>
        )}
      </SettingsSection>

      {cwd && autoApplied.length > 0 ? (
        <SettingsSection title="Auto-applied">
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-4">
            <p className="text-sm text-fg-muted">
              {autoApplied.length} rule file{autoApplied.length === 1 ? "" : "s"} injected into the
              system prompt for every new agent session in this workspace.
            </p>
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}

function ruleSourceLabel(source: RuleSource): string {
  switch (source) {
    case "agents-md":
      return "AGENTS.md";
    case "claude-md":
      return "CLAUDE.md";
    case "cursorrules":
      return ".cursorrules";
    case "cursor-rule":
      return ".mdc";
  }
}

function RuleModeBadge({ mode }: { mode: RuleMode }) {
  const label =
    mode === "always"
      ? "Always"
      : mode === "glob"
        ? "Glob"
        : mode === "intelligent"
          ? "Intelligent"
          : "Manual";
  const tone =
    mode === "always"
      ? "bg-focus-ring-soft/15 text-focus-ring-soft"
      : "bg-chip-faint text-fg-faint";
  return <span className={cn("shrink-0 rounded px-1.5 py-px text-2xs", tone)}>{label}</span>;
}
