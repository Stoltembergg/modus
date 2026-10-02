/**
 * Copy for the Files panel's unsaved-draft guards (C2.2). The Files panel does
 * not use an i18n catalog (its other strings are inline English), so these stay
 * local, in English like the rest of the panel, and in one place so C6 can move
 * them into the catalog.
 */
export const FILES_DIRTY_COPY = {
  keptDraftNotice: "Unsaved changes — the line may have moved",
  dialogTitle: (name: string) => `Save changes to ${name}?`,
  dialogDescription: "You have unsaved changes. If you discard them, they will be lost.",
  save: "Save",
  discard: "Discard",
  cancel: "Cancel",
  saveFailed: (message: string) => `Couldn't save: ${message}`,
} as const;
