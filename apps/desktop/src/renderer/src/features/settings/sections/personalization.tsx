function PersonalizationSettingsPanel() {
  const [state, setState] = useState<PersonalizationState | undefined>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.modus.personalization.get();
      setState(next);
      setDraft(next.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: initial load only; refresh is also used by Open file.
  useEffect(() => {
    void refresh();
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const next = await window.modus.personalization.save({ content: draft });
      setState(next);
      setDraft(next.content);
      setMessage("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function openFile(): Promise<void> {
    setError(undefined);
    try {
      await window.modus.personalization.open();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const dirty = state ? draft !== state.content : false;

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
              disabled={loading || saving}
              onClick={() => void openFile()}
              type="button"
            >
              <IconFileText size={14} stroke={1.7} />
              Open file
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
              disabled={!dirty || loading || saving}
              onClick={() => void save()}
              type="button"
            >
              <IconCheck size={13} stroke={2} />
              {saving ? <ShinyText className="text-canvas">Saving…</ShinyText> : "Save"}
            </button>
          </>
        }
        description="Persistent AGENTS.md guidance loaded before workspace rules."
        title="Personalization"
      />

      {error ? <p className="-mt-4 text-danger text-xs">{error}</p> : null}
      {message ? <p className="-mt-4 text-success text-xs">{message}</p> : null}

      <SettingsSection title="Custom instructions">
        <textarea
          className="scroll-thin min-h-[320px] resize-y rounded-lg border border-hairline-soft bg-panel px-4 py-3 font-mono text-sm text-fg leading-6 outline-none placeholder:text-fg-faint focus:border-focus-ring disabled:opacity-60"
          disabled={loading}
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage(undefined);
          }}
          placeholder="Add custom instructions..."
          value={loading ? "" : draft}
        />
      </SettingsSection>

      {state ? (
        <SettingsSection title="Files">
          <SettingsList>
            <SettingsRow
              control={<ReadOnlyPill>{state.overrideActive ? "Override" : "Base"}</ReadOnlyPill>}
              description={state.activePath}
              title="Active file"
            />
            <SettingsRow
              control={<ReadOnlyPill>{state.overrideActive ? "Active" : "Inactive"}</ReadOnlyPill>}
              description={state.overridePath}
              title="AGENTS.override.md"
            />
          </SettingsList>
        </SettingsSection>
      ) : null}
    </>
  );
}
