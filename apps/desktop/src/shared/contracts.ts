export type WorkspaceInfo = {
  id: string;
  rootPath: string;
  displayName: string;
  isGitRepository: boolean;
  lastOpenedAt: string;
  /** Pinned projects sort to the top of the sidebar's Projects list. */
  pinned: boolean;
  /**
   * Inbox chats with no project folder selected. Hidden from Projects and
   * listed under the sidebar Chats section instead.
   */
  inbox?: boolean;
};

/** Stable workspace id for folderless chats (sidebar → Chats). */
export const CHATS_WORKSPACE_ID = "modus-inbox-chats";

export * from "./contracts-more-a";
export * from "./contracts-more-b";
