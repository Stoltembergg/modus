/**
 * Copy for the Files panel's unsaved-draft guards (C2.2). The Files panel does
 * not use an i18n catalog (its other strings are inline), so these stay local,
 * in the pt-BR wording that was specified for them, and in one place so they
 * are easy to move into a catalog later.
 */
export const FILES_DIRTY_COPY = {
  keptDraftNotice: "Edições não salvas — a linha pode ter mudado",
  dialogTitle: (name: string) => `Salvar as alterações em ${name}?`,
  dialogDescription: "Você tem edições não salvas. Se descartar, elas serão perdidas.",
  save: "Salvar",
  discard: "Descartar",
  cancel: "Cancelar",
  saveFailed: (message: string) => `Não foi possível salvar: ${message}`,
} as const;
