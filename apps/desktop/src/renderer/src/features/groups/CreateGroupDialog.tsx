import { Dialog } from "@base-ui/react/dialog";
import { IconCrown } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentSessionInfo,
  CreateAgentGroupInput,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import { eligibleGroupSessions } from "./groupSidebarModel";

/** Select value for "no Project" (members come from the Chats inbox). */
const NO_PROJECT = "";

type CreateGroupDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Projects offered in the Project picker (the Chats inbox is excluded). */
  workspaces: readonly WorkspaceInfo[];
  /** Candidate sessions (root, non-archived); filtered further by eligibility. */
  sessions: readonly AgentSessionInfo[];
  /** Sessions already in some group (never offered). */
  memberSessionIds: ReadonlySet<string>;
  /** Project preselected when the dialog opens (e.g. the active one); default no Project. */
  defaultWorkspaceId?: string | null;
  onCreate(input: CreateAgentGroupInput): Promise<void>;
};

function errorMessage(caught: unknown): string {
  const text = caught instanceof Error ? caught.message : String(caught);
  // Electron prefixes remote errors: "Error invoking remote method 'x': Error: msg".
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

/**
 * Single-screen "New group" dialog: name, Project (optional), members, lead.
 * It only groups EXISTING chats: it never creates sessions.
 */
export function CreateGroupDialog({
  open,
  onOpenChange,
  workspaces,
  sessions,
  memberSessionIds,
  defaultWorkspaceId = null,
  onCreate,
}: CreateGroupDialogProps) {
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string>(NO_PROJECT);
  const [selected, setSelected] = useState<string[]>([]);
  const [leadSessionId, setLeadSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const nameRef = useRef<HTMLInputElement>(null);

  const projects = useMemo(() => workspaces.filter((workspace) => !workspace.inbox), [workspaces]);

  useEffect(() => {
    if (open) {
      setName("");
      const initial =
        defaultWorkspaceId && projects.some((project) => project.id === defaultWorkspaceId)
          ? defaultWorkspaceId
          : NO_PROJECT;
      setWorkspaceId(initial);
      setSelected([]);
      setLeadSessionId(null);
      setBusy(false);
      setError(undefined);
    }
  }, [open, defaultWorkspaceId, projects]);

  const eligible = useMemo(
    () => eligibleGroupSessions(sessions, workspaceId || null, memberSessionIds),
    [sessions, workspaceId, memberSessionIds],
  );
  const selectedSessions = eligible.filter((session) => selected.includes(session.id));
  const canCreate = name.trim().length > 0 && selectedSessions.length > 0 && !busy;

  function changeProject(next: string): void {
    setWorkspaceId(next);
    // Members must belong to the chosen Project: reset the picks.
    setSelected([]);
    setLeadSessionId(null);
  }

  function toggleMember(sessionId: string): void {
    setSelected((current) => {
      if (current.includes(sessionId)) {
        if (leadSessionId === sessionId) setLeadSessionId(null);
        return current.filter((id) => id !== sessionId);
      }
      return [...current, sessionId];
    });
  }

  async function submit(): Promise<void> {
    if (!canCreate) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({
        name: name.trim(),
        workspaceId: workspaceId || null,
        members: selectedSessions.map((session) => ({ sessionId: session.id })),
        leadSessionId: leadSessionId && selected.includes(leadSessionId) ? leadSessionId : null,
      });
      onOpenChange(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 ease-out-quint motion-reduce:transition-none",
            "data-ending-style:opacity-0 data-starting-style:opacity-0",
          )}
        />
        <Dialog.Popup
          className={cn(
            "-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-2rem))]",
            "origin-center overflow-hidden popup-chrome outline-none",
            "transition-[transform,opacity,scale] duration-150 ease-out-quint motion-reduce:transition-none",
            "data-ending-style:scale-[0.96] data-ending-style:opacity-0",
            "data-starting-style:scale-[0.96] data-starting-style:opacity-0",
          )}
          initialFocus={nameRef}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="px-4 pt-3.5 pb-1">
              <Dialog.Title className="font-medium text-fg text-sm">New group</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-2xs text-fg-faint">
                Group existing chats so they can work together.
              </Dialog.Description>
            </div>

            <div className="flex flex-col gap-3 px-4 pt-2">
              <label className="flex flex-col gap-1">
                <span className="text-2xs text-fg-subtle">Name</span>
                <input
                  className={cn(
                    "h-8 w-full rounded-lg border border-hairline bg-canvas px-2.5 text-sm text-fg outline-none",
                    "transition-colors placeholder:text-fg-faint focus:border-hairline-strong",
                  )}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Release squad"
                  ref={nameRef}
                  value={name}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-2xs text-fg-subtle">Project</span>
                <select
                  className={cn(
                    "h-8 w-full rounded-lg border border-hairline bg-canvas px-2 text-sm text-fg outline-none",
                    "focus:border-hairline-strong",
                  )}
                  onChange={(event) => changeProject(event.target.value)}
                  value={workspaceId}
                >
                  <option value={NO_PROJECT}>No project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.displayName}
                    </option>
                  ))}
                </select>
              </label>

              <fieldset className="flex min-w-0 flex-col gap-1">
                <legend className="mb-1 text-2xs text-fg-subtle">Members</legend>
                {eligible.length === 0 ? (
                  <p className="rounded-lg border border-hairline border-dashed px-2.5 py-2 text-2xs text-fg-faint">
                    {workspaceId
                      ? "No available chats in this project. Chats already in a group, archived chats and subagents can't be added."
                      : "No available chats without a folder. Chats already in a group, archived chats and subagents can't be added."}
                  </p>
                ) : (
                  <ul className="scroll-thin max-h-44 overflow-y-auto rounded-lg border border-hairline">
                    {eligible.map((session) => {
                      const checked = selected.includes(session.id);
                      return (
                        <li key={session.id}>
                          <label className="flex h-8 cursor-pointer items-center gap-2 px-2.5 text-xs text-fg-muted hover:bg-hover">
                            <input
                              checked={checked}
                              className="size-3.5 shrink-0"
                              onChange={() => toggleMember(session.id)}
                              type="checkbox"
                            />
                            <span className="min-w-0 flex-1 truncate">{session.title}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </fieldset>

              <label className="flex flex-col gap-1">
                <span className="flex items-center gap-1 text-2xs text-fg-subtle">
                  <IconCrown size={12} stroke={1.7} />
                  Lead
                </span>
                <select
                  className={cn(
                    "h-8 w-full rounded-lg border border-hairline bg-canvas px-2 text-sm text-fg outline-none",
                    "focus:border-hairline-strong disabled:opacity-50",
                  )}
                  disabled={selectedSessions.length === 0}
                  onChange={(event) => setLeadSessionId(event.target.value || null)}
                  value={leadSessionId ?? ""}
                >
                  <option value="">No lead</option>
                  {selectedSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {error ? (
              <div
                className="mx-4 mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/8 px-2.5 py-2 text-xs text-danger"
                role="alert"
              >
                {error}
              </div>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2 border-hairline-soft border-t px-4 py-2.5">
              <button
                className="h-7 rounded-md px-3 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                onClick={() => onOpenChange(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className={cn(
                  "h-7 rounded-md px-3 text-xs transition-colors",
                  canCreate
                    ? "bg-accent text-white hover:opacity-90"
                    : "cursor-not-allowed bg-chip-strong text-fg-faint",
                )}
                disabled={!canCreate}
                type="submit"
              >
                {busy ? "Creating…" : "Create group"}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
