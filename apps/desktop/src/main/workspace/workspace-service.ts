import { dialog, shell } from "electron";
import type { WorkspaceInfo } from "../../shared/contracts";
import { archiveWorkspaceSessions, deleteWorkspaceSessions } from "../agent/session-lifecycle";
import { isGitRepository } from "../git/git-service";
import {
  ensureChatsWorkspace,
  getWorkspace,
  listProjectWorkspaces,
  removeWorkspace,
  renameWorkspace,
  setWorkspacePinned,
  upsertWorkspace,
} from "./workspace-store";

export async function openWorkspace(): Promise<WorkspaceInfo | undefined> {
  const result = await dialog.showOpenDialog({
    title: "Open Modus Workspace",
    properties: ["openDirectory"],
  });
  const rootPath = result.filePaths[0];
  if (result.canceled || !rootPath) {
    return undefined;
  }
  return upsertWorkspace(rootPath, await isGitRepository(rootPath));
}

export function getRecentWorkspaces(): WorkspaceInfo[] {
  return listProjectWorkspaces();
}

export { ensureChatsWorkspace };

/** Pin / unpin a project; returns the re-sorted recents. */
export function setProjectPinned(id: string, pinned: boolean): WorkspaceInfo[] {
  setWorkspacePinned(id, pinned);
  return listProjectWorkspaces();
}

/** Rename a project's sidebar label; returns the updated recents. */
export function renameProject(id: string, displayName: string): WorkspaceInfo[] {
  renameWorkspace(id, displayName);
  return listProjectWorkspaces();
}

/** Soft-archive a project's visible chats (group members excluded). Returns count archived. */
export async function archiveProjectChats(id: string): Promise<number> {
  return archiveWorkspaceSessions(id);
}

/** Permanently delete a project's chats (group members excluded). Returns count deleted. */
export async function deleteProjectChats(id: string): Promise<number> {
  return deleteWorkspaceSessions(id);
}

/**
 * Remove a project from Modus: tear down all of its sessions first (no orphaned
 * runtimes/checkpoints), then drop the workspace row. Files on disk are kept.
 */
export async function removeProject(id: string): Promise<WorkspaceInfo[]> {
  // Everything goes, group members included; the groups cascade with the workspace row.
  await deleteWorkspaceSessions(id, { includeGroupMembers: true });
  removeWorkspace(id);
  return listProjectWorkspaces();
}

/** Reveal a project's root folder in the OS file manager. */
export async function revealProject(id: string): Promise<void> {
  const workspace = getWorkspace(id);
  if (!workspace) {
    return;
  }
  const failure = await shell.openPath(workspace.rootPath);
  if (failure) {
    throw new Error(failure);
  }
}
