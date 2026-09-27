import { IconCube, IconPlus, IconWorld } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { SkillInfo } from "../../../../../shared/contracts";
import { CollapsibleMotion } from "../../../components/ui/CollapsibleMotion";
import { ShinyText } from "../../../components/ui/ShinyText";
import { SettingsList, SettingsPageHeader, SettingsSection } from "../settings-layout";

export function SkillsSettingsPanel({ cwd }: { cwd: string | undefined }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh(): Promise<void> {
    if (!cwd) {
      setSkills([]);
      return;
    }
    setLoading(true);
    setSkillsError(undefined);
    try {
      setSkills(await window.modus.skills.list(cwd));
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is recreated each render; cwd is the real trigger.
  useEffect(() => {
    void refresh();
  }, [cwd]);

  async function saveSkill(): Promise<void> {
    if (!cwd || !draftName.trim()) {
      return;
    }
    setSaving(true);
    setSkillsError(undefined);
    try {
      await window.modus.skills.create({
        cwd,
        name: draftName.trim(),
        description: draftDescription.trim(),
        body: draftBody.trim(),
      });
      setCreating(false);
      setDraftName("");
      setDraftDescription("");
      setDraftBody("");
      await refresh();
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function scopeBadge(skill: SkillInfo): string {
    if (skill.scope === "builtin") {
      return "builtin";
    }
    return skill.scope === "user" ? `user · ${skill.source}` : `project · ${skill.source}`;
  }

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
              disabled={!cwd}
              onClick={() => void window.modus.skills.openDir(cwd as string)}
              type="button"
            >
              <IconWorld size={14} stroke={1.7} />
              Open folder
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
              disabled={!cwd}
              onClick={() => setCreating((value) => !value)}
              type="button"
            >
              <IconPlus size={14} stroke={2} />
              New
            </button>
          </>
        }
        description="Skills are specialized capabilities that help the agent accomplish specific tasks. Skills are invoked by the agent when relevant, or triggered manually with / in chat."
        singleLineDescription
        title="Skills"
      />

      {skillsError ? <p className="-mt-4 text-danger text-xs">{skillsError}</p> : null}

      <CollapsibleMotion open={creating && Boolean(cwd)} preset="default">
        <div className="flex flex-col gap-3 rounded-lg border border-hairline-soft bg-panel px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-subtle">Name</span>
            <input
              className="h-8 rounded-md border border-hairline bg-surface px-2.5 text-sm text-fg outline-none focus:border-focus-ring"
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="code-review"
              value={draftName}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-subtle">Description</span>
            <textarea
              className="scroll-thin min-h-[68px] resize-none rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-fg leading-5 outline-none focus:border-focus-ring"
              maxLength={280}
              onChange={(event) => setDraftDescription(event.target.value)}
              placeholder="Review a diff for correctness and security"
              value={draftDescription}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-subtle">Instructions</span>
            <textarea
              className="scroll-thin min-h-48 resize-y rounded-md border border-hairline bg-surface px-3 py-2 font-mono text-xs text-fg leading-5 outline-none placeholder:text-fg-faint focus:border-focus-ring"
              onChange={(event) => setDraftBody(event.target.value)}
              placeholder={
                "# code-review\n\nUse this skill when reviewing code.\n\n## Steps\n\n1. Read the diff.\n2. Find correctness risks.\n3. Return concise findings first."
              }
              value={draftBody}
            />
          </label>
          <div className="flex items-center justify-end gap-2">
            <button
              className="flex h-8 items-center rounded-md border border-hairline bg-surface px-3 text-xs text-fg-muted transition-colors hover:bg-hover"
              onClick={() => setCreating(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
              disabled={!draftName.trim() || !draftBody.trim() || saving}
              onClick={() => void saveSkill()}
              type="button"
            >
              {saving ? <ShinyText className="text-canvas">Creating…</ShinyText> : "Create skill"}
            </button>
          </div>
        </div>
      </CollapsibleMotion>

      <SettingsSection title="Available skills">
        {!cwd ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">Open a workspace to discover and create skills.</p>
          </div>
        ) : loading && skills.length === 0 ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6 text-sm text-fg-muted">
            <ShinyText>Discovering skills…</ShinyText>
          </div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">
              No skills yet. Create one, or drop a{" "}
              <span className="font-mono text-xs">SKILL.md</span> into{" "}
              <span className="font-mono text-xs">.modus/skills/&lt;name&gt;/</span>.
            </p>
          </div>
        ) : (
          <SettingsList>
            {skills.map((skill) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-hairline-soft border-b px-4 py-3 last:border-b-0"
                key={skill.path}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-5 shrink-0 items-center justify-center text-fg-faint">
                    <IconCube size={15} stroke={1.7} />
                  </span>
                  <span className="shrink-0 font-mono text-sm text-fg">/{skill.name}</span>
                  {skill.description ? (
                    <span className="min-w-0 truncate text-xs text-fg-subtle">
                      {skill.description}
                    </span>
                  ) : null}
                </div>
                <span className="shrink-0 rounded bg-chip-faint px-1.5 py-px text-2xs text-fg-faint">
                  {scopeBadge(skill)}
                </span>
              </div>
            ))}
          </SettingsList>
        )}
      </SettingsSection>
    </>
  );
}
